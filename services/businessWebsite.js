function normalizeBusinessWebsite(value) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== "string") {
        throw new Error("Enter a valid business website URL starting with https://.");
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    if (trimmed.length > 2048) {
        throw new Error("Business website must be 2,048 characters or fewer.");
    }

    let website;
    try {
        website = new URL(trimmed);
    } catch (error) {
        throw new Error("Enter a valid business website URL starting with https://.");
    }

    if (
        website.protocol !== "https:" ||
        !website.hostname ||
        website.username ||
        website.password
    ) {
        throw new Error("Business website must be a valid HTTPS URL without embedded credentials.");
    }

    return website.toString();
}

module.exports = { normalizeBusinessWebsite };
