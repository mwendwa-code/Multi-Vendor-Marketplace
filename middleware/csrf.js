const crypto = require("crypto");

function csrfProtection(req, res, next) {
    if (!req.session) {
        return next(new Error("Session middleware must run before CSRF protection."));
    }

    if (typeof req.session.csrfToken !== "string") {
        req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    }

    res.locals.csrfToken = req.session.csrfToken;

    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        return next();
    }

    if (
        req.method === "POST" &&
        /^\/seller\/refunds\/\d+\/response$/.test(req.path) &&
        req.is("multipart/form-data")
    ) {
        return next();
    }

    const submittedToken = req.body?._csrf || req.get("X-CSRF-Token");
    const expectedToken = req.session.csrfToken;
    const submittedBuffer = typeof submittedToken === "string" ? Buffer.from(submittedToken) : null;
    const expectedBuffer = Buffer.from(expectedToken);

    if (
        !submittedBuffer ||
        submittedBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(submittedBuffer, expectedBuffer)
    ) {
        if (req.method === "POST" && req.path === "/auth/login") {
            return res.redirect(303, "/login?csrf=expired");
        }
        return res.status(403).send("Your request could not be verified. Reload the page and try again.");
    }

    return next();
}

module.exports = csrfProtection;
