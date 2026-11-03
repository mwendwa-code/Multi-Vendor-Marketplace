const path = require("path");

const uploadsDirectory = path.resolve(
    process.env.UPLOADS_DIR ||
    path.join(__dirname, "..", "..", "frontend", "public", "uploads")
);
const refundEvidenceDirectory = path.resolve(
    process.env.REFUND_EVIDENCE_DIR ||
    path.join(__dirname, "..", "private", "refund-evidence")
);

module.exports = {
    uploadsDirectory,
    refundEvidenceDirectory
};
