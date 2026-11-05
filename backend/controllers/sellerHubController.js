const db = require("../database/db");
const { recordAuditEvent } = require("../database/audit");
const { normalizePhoneNumber } = require("./paymentController");
const { adjustProductStock } = require("../services/inventory");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { refundEvidenceDirectory } = require("../services/fileStorage");

async function removeRefundEvidence(evidenceKey, context) {
    if (!/^[a-f0-9]{32}\.(?:webp|pdf)$/.test(evidenceKey || "")) return;
    try {
        await fs.unlink(path.join(refundEvidenceDirectory, evidenceKey));
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error(`${context}:`, error.message);
        }
    }
}

exports.updateFulfillment = async (req, res) => {
    const orderId = Number(req.params.id);
    const status = req.body?.status;
    if (req.body?.trackingNumber !== undefined && typeof req.body.trackingNumber !== "string") {
        return res.status(400).send("Enter valid tracking details.");
    }
    const trackingNumber = typeof req.body?.trackingNumber === "string"
        ? req.body.trackingNumber.trim()
        : "";

    if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).send("Invalid order.");
    }
    if (!["processing", "shipped"].includes(status)) {
        return res.status(400).send("Choose a valid fulfillment status.");
    }
    if (trackingNumber.length > 100 || /[\u0000-\u001f\u007f]/.test(trackingNumber)) {
        return res.status(400).send("Tracking details must be 100 characters or fewer.");
    }

    try {
        const updated = await db.transaction(async (connection) => {
            const [orders] = await connection.execute(
                `SELECT o.status, f.status AS fulfillment_status, d.status AS seller_decision
                 FROM order_items oi
                 JOIN orders o ON o.id = oi.order_id
                 LEFT JOIN seller_order_fulfillments f
                   ON f.order_id = o.id AND f.seller_id = oi.seller_id
                 LEFT JOIN seller_order_decisions d
                   ON d.order_id = o.id AND d.seller_id = oi.seller_id
                 WHERE o.id = ? AND oi.seller_id = ?
                 LIMIT 1`,
                [orderId, req.session.user.id]
            );
            const order = orders[0];
            if (!order) return "not_found";
            if (order.status === "cancelled" || order.status === "pending") return "unavailable";
            if (order.seller_decision === "rejected") return "rejected";
            if (order.seller_decision !== "accepted") return "not_accepted";

            const currentStatus = order.fulfillment_status || "pending";
            if (
                (currentStatus === "pending" && status !== "processing") ||
                (currentStatus === "processing" && status !== "shipped") ||
                currentStatus === "shipped"
            ) {
                return "invalid_transition";
            }

            await connection.execute(
                `INSERT INTO seller_order_fulfillments
                    (order_id, seller_id, status, tracking_number)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(order_id, seller_id) DO UPDATE SET
                    status = excluded.status,
                    tracking_number = excluded.tracking_number,
                    updated_at = CURRENT_TIMESTAMP`,
                [orderId, req.session.user.id, status, trackingNumber || null]
            );
            return "updated";
        });

        if (updated === "not_found") return res.status(404).send("Order not found for this seller.");
        if (updated === "unavailable") {
            return res.status(409).send("This order is not ready for seller fulfillment.");
        }
        if (updated === "rejected") return res.status(409).send("Rejected order items cannot be fulfilled.");
        if (updated === "not_accepted") return res.status(409).send("Accept this seller order before starting fulfillment.");
        if (updated === "invalid_transition") {
            return res.status(409).send("That fulfillment step has already been completed or is out of order.");
        }

        await recordAuditEvent(req.session.user.id, `seller_fulfillment_updated:${orderId}:${status}`);
        return res.redirect("/seller?fulfillment=updated#order-fulfillment");
    } catch (error) {
        console.error("Seller fulfillment update error:", error.message);
        return res.status(500).send("Could not update order fulfillment.");
    }
};

exports.updateOrderDecision = async (req, res) => {
    const orderId = Number(req.params.id);
    const decision = req.body?.decision;
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!Number.isSafeInteger(orderId) || orderId <= 0 ||
        !["accepted", "rejected"].includes(decision)) {
        return res.status(400).send("Choose a valid order decision.");
    }
    if (decision === "rejected" && (!note || note.length > 500)) {
        return res.status(400).send("Provide a rejection reason of up to 500 characters.");
    }
    if (note.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) {
        return res.status(400).send("Order notes must be 500 characters or fewer.");
    }

    try {
        const result = await db.transaction(async (connection) => {
            const [orders] = await connection.execute(
                `SELECT o.id, o.status, COALESCE(f.status, 'pending') AS fulfillment_status
                 FROM orders o
                 JOIN order_items oi ON oi.order_id = o.id
                 JOIN payments p ON p.order_id = o.id AND p.status = 'successful'
                 LEFT JOIN seller_order_fulfillments f
                   ON f.order_id = o.id AND f.seller_id = oi.seller_id
                 WHERE o.id = ? AND oi.seller_id = ?
                   AND o.status IN ('paid', 'processing')
                   AND COALESCE(f.status, 'pending') = 'pending'
                 LIMIT 1`,
                [orderId, req.session.user.id]
            );
            if (!orders.length) return "unavailable";
            const [existingDecisions] = await connection.execute(
                "SELECT status FROM seller_order_decisions WHERE order_id = ? AND seller_id = ?",
                [orderId, req.session.user.id]
            );
            if (existingDecisions.length) return "already_decided";
            if (decision === "rejected") {
                const [items] = await connection.execute(
                    "SELECT product_id, quantity FROM order_items WHERE order_id = ? AND seller_id = ?",
                    [orderId, req.session.user.id]
                );
                for (const item of items) {
                    await adjustProductStock(
                        connection,
                        Number(item.product_id),
                        Number(item.quantity),
                        "seller-order-rejected"
                    );
                }
                await connection.execute(
                    `UPDATE commissions
                     SET status = 'void'
                     WHERE order_id = ? AND seller_id = ? AND status IN ('pending', 'earned')`,
                    [orderId, req.session.user.id]
                );
            }
            await connection.execute(
                `INSERT INTO seller_order_decisions (order_id, seller_id, status, note)
                 VALUES (?, ?, ?, ?)`,
                [orderId, req.session.user.id, decision, note || null]
            );
            return "updated";
        });
        if (result === "unavailable") {
            return res.status(409).send("Only your items in successfully paid orders can be accepted or rejected.");
        }
        if (result === "already_decided") {
            return res.status(409).send("You have already made a decision for this order.");
        }
        await recordAuditEvent(req.session.user.id, `seller_order_${decision}:${orderId}`);
        return res.redirect(`/seller?orderDecision=${decision}#orders-management`);
    } catch (error) {
        console.error("Seller order decision error:", error.message);
        return res.status(500).send("Could not save your order decision.");
    }
};

exports.respondToRefund = async (req, res) => {
    const refundId = Number(req.params.id);
    const response = typeof req.body?.response === "string" ? req.body.response.trim() : "";
    if (!Number.isSafeInteger(refundId) || refundId <= 0 ||
        !response || response.length > 2000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(response)) {
        return res.status(400).send("Provide an explanation of up to 2,000 characters.");
    }

    let evidenceKey = null;
    let evidenceSaved = false;
    try {
        if (req.file) {
            if (req.file.mimetype === "application/pdf") {
                if (!req.file.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
                    return res.status(400).send("The uploaded file is not a valid PDF.");
                }
                evidenceKey = `${crypto.randomBytes(16).toString("hex")}.pdf`;
                await fs.mkdir(refundEvidenceDirectory, { recursive: true });
                await fs.writeFile(path.join(refundEvidenceDirectory, evidenceKey), req.file.buffer, { flag: "wx" });
            } else {
                let image;
                try {
                    image = await sharp(req.file.buffer, { failOn: "error", limitInputPixels: 16_000_000 })
                        .rotate()
                        .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
                        .webp({ quality: 82 })
                        .toBuffer();
                } catch (error) {
                    console.warn("Rejected invalid refund evidence image:", error.message);
                    return res.status(400).send("The uploaded image could not be decoded.");
                }
                evidenceKey = `${crypto.randomBytes(16).toString("hex")}.webp`;
                await fs.mkdir(refundEvidenceDirectory, { recursive: true });
                await fs.writeFile(path.join(refundEvidenceDirectory, evidenceKey), image, { flag: "wx" });
            }
        }

        const previousEvidenceKey = await db.transaction(async (connection) => {
            const [existingRows] = await connection.execute(
                `SELECT evidence_key
                 FROM refund_requests
                 WHERE id = ? AND status IN ('pending', 'approved')
                   AND EXISTS (
                       SELECT 1 FROM order_items oi
                       WHERE oi.order_id = refund_requests.order_id AND oi.seller_id = ?
                   )`,
                [refundId, req.session.user.id]
            );
            if (!existingRows.length) return { saved: false, previousEvidenceKey: null };

            const [result] = await connection.execute(
                `UPDATE refund_requests
                 SET seller_response = ?, evidence_key = COALESCE(?, evidence_key), updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status IN ('pending', 'approved')
                   AND EXISTS (
                       SELECT 1 FROM order_items oi
                       WHERE oi.order_id = refund_requests.order_id AND oi.seller_id = ?
                   )`,
                [response, evidenceKey, refundId, req.session.user.id]
            );
            return {
                saved: Boolean(result.rowsAffected),
                previousEvidenceKey: existingRows[0].evidence_key
            };
        });
        if (!previousEvidenceKey.saved) {
            if (evidenceKey) await removeRefundEvidence(evidenceKey, "Unused refund evidence cleanup error");
            return res.status(404).send("Open refund request not found for your products.");
        }
        evidenceSaved = true;
        if (
            evidenceKey && previousEvidenceKey.previousEvidenceKey &&
            previousEvidenceKey.previousEvidenceKey !== evidenceKey
        ) {
            await removeRefundEvidence(previousEvidenceKey.previousEvidenceKey, "Replaced refund evidence cleanup error");
        }
        await recordAuditEvent(req.session.user.id, `seller_refund_response:${refundId}`);
        return res.redirect("/seller?refund=updated#seller-refunds");
    } catch (error) {
        if (evidenceKey && !evidenceSaved) {
            await removeRefundEvidence(evidenceKey, "Refund evidence cleanup error");
        }
        console.error("Seller refund response error:", error.message);
        return res.status(500).send("Could not save the refund investigation response.");
    }
};

exports.downloadRefundEvidence = async (req, res) => {
    const refundId = Number(req.params.id);
    if (!Number.isSafeInteger(refundId) || refundId <= 0) {
        return res.status(400).send("Invalid refund request.");
    }
    try {
        const [rows] = await db.execute(
            `SELECT r.evidence_key, r.order_id
             FROM refund_requests r
             WHERE r.id = ? AND r.evidence_key IS NOT NULL
               AND (? = 'admin' OR EXISTS (
                   SELECT 1 FROM order_items oi
                   WHERE oi.order_id = r.order_id AND oi.seller_id = ?
               ))`,
            [refundId, req.session.user.role, req.session.user.id]
        );
        const evidenceKey = rows[0]?.evidence_key;
        if (!evidenceKey || !/^[a-f0-9]{32}\.(?:webp|pdf)$/.test(evidenceKey)) {
            return res.status(404).send("Refund evidence not found.");
        }
        res.set("Cache-Control", "private, no-store");
        return res.download(path.join(refundEvidenceDirectory, evidenceKey), evidenceKey, (error) => {
            if (!error) return;
            if (error.code === "ENOENT") return res.status(404).send("Refund evidence file not found.");
            console.error("Refund evidence download error:", error.message);
            return res.status(500).send("Could not download refund evidence.");
        });
    } catch (error) {
        console.error("Refund evidence lookup error:", error.message);
        return res.status(500).send("Could not load refund evidence.");
    }
};

exports.respondToReview = async (req, res) => {
    const reviewId = Number(req.params.id);
    const response = typeof req.body?.response === "string" ? req.body.response.trim() : "";
    if (!Number.isSafeInteger(reviewId) || reviewId <= 0 ||
        !response || response.length > 1000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(response)) {
        return res.status(400).send("Write a review response of up to 1,000 characters.");
    }

    try {
        const [result] = await db.execute(
            `INSERT INTO seller_review_responses (review_id, seller_id, response)
             SELECT r.id, ?, ?
             FROM reviews r
             JOIN products p ON p.id = r.product_id
             WHERE r.id = ? AND p.seller_id = ?
             ON CONFLICT(review_id) DO UPDATE SET
                response = excluded.response, created_at = CURRENT_TIMESTAMP`,
            [req.session.user.id, response, reviewId, req.session.user.id]
        );
        if (!result.rowsAffected) return res.status(404).send("Review not found for your products.");
        await recordAuditEvent(req.session.user.id, `seller_review_responded:${reviewId}`);
        return res.redirect("/seller?review=responded#seller-reviews");
    } catch (error) {
        console.error("Seller review response error:", error.message);
        return res.status(500).send("Could not save your review response.");
    }
};

exports.reportReview = async (req, res) => {
    const reviewId = Number(req.params.id);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!Number.isSafeInteger(reviewId) || reviewId <= 0 ||
        !reason || reason.length > 1000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
        return res.status(400).send("Provide a report reason of up to 1,000 characters.");
    }
    try {
        const [result] = await db.execute(
            `INSERT INTO seller_review_reports (review_id, seller_id, reason)
             SELECT r.id, ?, ?
             FROM reviews r
             JOIN products p ON p.id = r.product_id
             WHERE r.id = ? AND p.seller_id = ?
             ON CONFLICT(review_id, seller_id) DO UPDATE SET
                reason = excluded.reason, status = 'pending', updated_at = CURRENT_TIMESTAMP`,
            [req.session.user.id, reason, reviewId, req.session.user.id]
        );
        if (!result.rowsAffected) return res.status(404).send("Review not found for your products.");
        await recordAuditEvent(req.session.user.id, `seller_review_reported:${reviewId}`);
        return res.redirect("/seller?review=reported#seller-reviews");
    } catch (error) {
        console.error("Seller review report error:", error.message);
        return res.status(500).send("Could not report this review.");
    }
};

exports.requestPayout = async (req, res) => {
    const rawAmount = req.body?.amount;
    const amountText = typeof rawAmount === "string" ? rawAmount.trim() : "";
    const amount = Number(amountText);
    const payoutPhone = normalizePhoneNumber(req.body?.payoutPhone);
    if (
        !/^\d+(?:\.\d{1,2})?$/.test(amountText) ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > 99999999.99
    ) {
        return res.status(400).send("Enter a valid payout amount.");
    }
    if (!payoutPhone) {
        return res.status(400).send("Enter a valid Kenyan M-Pesa payout number.");
    }

    try {
        const result = await db.transaction(async (connection) => {
            const [earningsRows] = await connection.execute(
                `SELECT COALESCE(SUM(seller_net_amount), 0) AS earned
                 FROM commissions
                 WHERE seller_id = ? AND status = 'earned'`,
                [req.session.user.id]
            );
            const [reservedRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) AS reserved
                 FROM seller_payout_requests
                 WHERE seller_id = ? AND status IN ('pending', 'approved', 'paid')`,
                [req.session.user.id]
            );
            const available = Math.round(
                (Number(earningsRows[0]?.earned || 0) - Number(reservedRows[0]?.reserved || 0)) * 100
            ) / 100;
            if (amount > available) return false;

            const [inserted] = await connection.execute(
                `INSERT INTO seller_payout_requests (seller_id, amount, payout_phone)
                 VALUES (?, ?, ?)
                 RETURNING id`,
                [req.session.user.id, amount, payoutPhone]
            );
            return inserted.insertId;
        });

        if (!result) {
            return res.status(400).send("The requested amount exceeds your available earnings.");
        }
        await recordAuditEvent(req.session.user.id, `seller_payout_requested:${result}`);
        return res.redirect("/seller?payout=requested#payout-hub");
    } catch (error) {
        console.error("Seller payout request error:", error.message);
        return res.status(500).send("Could not submit your payout request.");
    }
};

exports.reviewPayoutRequest = async (req, res) => {
    const requestId = Number(req.params.id);
    const status = req.body?.status;
    const payoutStatusFilter = ["all", "pending", "completed", "failed"].includes(req.body?.payoutStatus)
        ? req.body.payoutStatus
        : "all";
    const requestedPage = Number.parseInt(req.body?.payoutPage, 10);
    const payoutPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    if (!Number.isInteger(requestId) || requestId <= 0) {
        return res.status(400).send("Invalid payout request.");
    }
    if (!["approved", "rejected", "paid"].includes(status)) {
        return res.status(400).send("Choose a valid payout review action.");
    }
    if (status === "paid" && req.body?.paymentVerified !== "confirmed") {
        return res.status(400).send("Confirm that the transfer was verified before marking this payout paid.");
    }

    try {
        const result = await db.transaction(async (connection) => {
            const [requests] = await connection.execute(
                "SELECT id, seller_id, amount, status FROM seller_payout_requests WHERE id = ?",
                [requestId]
            );
            if (!requests[0]) return "not_found";
            const request = requests[0];
            const currentStatus = request.status;
            if (
                (currentStatus === "pending" && !["approved", "rejected"].includes(status)) ||
                (currentStatus === "approved" && status !== "paid")
            ) {
                return "invalid_transition";
            }
            if (currentStatus !== "pending" && currentStatus !== "approved") {
                return "invalid_transition";
            }

            if (status === "approved") {
                const [balanceRows] = await connection.execute(
                    `SELECT GREATEST(0,
                                COALESCE((SELECT SUM(c.seller_net_amount)
                                          FROM commissions c
                                          WHERE c.seller_id = ? AND c.status = 'earned'), 0)
                                - COALESCE((SELECT SUM(r.amount)
                                            FROM seller_payout_requests r
                                            WHERE r.seller_id = ?
                                              AND r.id != ?
                                              AND r.status IN ('pending', 'approved', 'paid')), 0)
                             ) AS available_balance`,
                    [request.seller_id, request.seller_id, requestId]
                );
                if (Number(request.amount) > Number(balanceRows[0]?.available_balance || 0)) {
                    return "insufficient_balance";
                }
            }

            await connection.execute(
                `UPDATE seller_payout_requests
                 SET status = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [status, requestId]
            );
            return "updated";
        });

        if (result === "not_found") return res.status(404).send("Payout request not found.");
        if (result === "invalid_transition") {
            return res.status(409).send("That payout request has already been reviewed.");
        }
        if (result === "insufficient_balance") {
            return res.status(409).send("The seller no longer has enough available balance to approve this payout.");
        }

        await recordAuditEvent(req.session.user.id, `seller_payout_${status}:${requestId}`);
        return res.redirect(
            `/admin?payout=updated&payoutStatus=${encodeURIComponent(payoutStatusFilter)}&payoutPage=${payoutPage}#payout-requests`
        );
    } catch (error) {
        console.error("Payout review error:", error.message);
        return res.status(500).send("Could not update the payout request.");
    }
};
