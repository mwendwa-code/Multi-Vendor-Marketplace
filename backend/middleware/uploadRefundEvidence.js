const multer = require("multer");

const evidenceUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        files: 1,
        fileSize: 5 * 1024 * 1024,
        fields: 3,
        fieldSize: 8 * 1024
    },
    fileFilter(req, file, callback) {
        if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            return callback(new Error("Refund evidence must be a PDF, JPEG, PNG, or WebP file."));
        }
        return callback(null, true);
    }
});

module.exports = {
    single(req, res, next) {
        evidenceUpload.single("evidence")(req, res, (error) => {
            if (!error) return next();
            if (error.code === "LIMIT_FILE_SIZE") {
                return res.status(413).send("Refund evidence must be 5 MB or smaller.");
            }
            if (
                error instanceof multer.MulterError ||
                (typeof error.message === "string" && error.message.startsWith("Refund evidence"))
            ) {
                return res.status(400).send(error.message);
            }
            return next(error);
        });
    }
};
