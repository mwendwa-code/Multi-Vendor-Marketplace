function createRateLimiter({ windowMs, max, message }) {
    const requestsByIp = new Map();

    return (req, res, next) => {
        const now = Date.now();
        const key = req.ip || req.socket.remoteAddress || "unknown";
        const current = requestsByIp.get(key);

        if (!current || current.resetAt <= now) {
            if (requestsByIp.size >= 10000) {
                for (const [ip, entry] of requestsByIp) {
                    if (entry.resetAt <= now) {
                        requestsByIp.delete(ip);
                    }
                }

                if (requestsByIp.size >= 10000) {
                    return res.status(503).send("Authentication is temporarily unavailable. Please try again later.");
                }
            }
            requestsByIp.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }

        if (current.count >= max) {
            res.set("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
            return res.status(429).send(message);
        }

        current.count += 1;
        return next();
    };
}

module.exports = { createRateLimiter };
