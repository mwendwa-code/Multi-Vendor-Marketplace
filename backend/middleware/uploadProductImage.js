const multer = require("multer");

const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        files: 1,
        fileSize: 5 * 1024 * 1024,
        fields: 7,
        fieldSize: 8 * 1024
    },
    fileFilter(req, file, callback) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            return callback(new Error("Only JPEG, PNG, and WebP product images are supported."));
        }

        return callback(null, true);
    }
});

module.exports = {
    single(req, res, next) {
        imageUpload.single("image")(req, res, (error) => {
            if (!error) return next();
            if (error.code === "LIMIT_FILE_SIZE") {
                return res.status(413).send("Product images must be 5 MB or smaller.");
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
