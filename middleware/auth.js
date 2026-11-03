
function normalizeRole(role) {
    if (role === "buyer" || role === "customer") {
        return "customer";
    }

    return role;
}

function requireLogin(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.redirect("/login");
    }

    next();
}

function redirectSellerFromShopping(req, res, next) {
    if (req.session?.user && normalizeRole(req.session.user.role) === "seller") {
        return res.redirect("/seller?shopping=disabled");
    }

    next();
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.session || !req.session.user) {
            return res.redirect("/login");
        }

        const normalizedUserRole = normalizeRole(req.session.user.role);
        const normalizedAllowedRoles = allowedRoles.map(normalizeRole);

        if (!normalizedAllowedRoles.includes(normalizedUserRole)) {
            return res.status(403).send("Access denied.");
        }

        if (normalizedUserRole === "admin" && req.session.mfaVerified !== true) {
            return req.session.destroy((error) => {
                if (error) return next(error);
                return res.redirect(303, "/login?mfa=required");
            });
        }

        next();
    };
}

module.exports = {
    requireLogin,
    requireRole,
    redirectSellerFromShopping,
    normalizeRole
};
