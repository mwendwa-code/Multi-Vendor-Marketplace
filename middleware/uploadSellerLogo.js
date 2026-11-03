const multer = require("multer");

const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        files: 1,
        fileSize: 2 * 1024 * 1024,
        fields: 4,
        fieldSize: 8 * 1024
    },
    fileFilter(req, file, callback) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            return callback(new Error("Only JPEG, PNG, and WebP seller logos are supported."));
        }

        return callback(null, true);
    }
});

module.exports = {
    single(req, res, next) {
        logoUpload.single("businessLogo")(req, res, (error) => {
            if (!error) return next();
            if (error.code === "LIMIT_FILE_SIZE") {
                return res.status(413).send("Seller logos must be 2 MB or smaller.");
            }
            if (
                error instanceof multer.MulterError ||
                (typeof error.message === "string" && error.message.startsWith("Only JPEG"))
            ) {
                return res.status(400).send(error.message);
            }
            return next(error);
        });
    }
};
