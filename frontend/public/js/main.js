const roleSelect = document.querySelector("#role");
const businessNameField = document.querySelector("#business-name-field");
const businessNameInput = document.querySelector("#businessName");
const businessWebsiteInput = document.querySelector("#businessWebsite");

if (roleSelect && businessNameField && businessNameInput) {
    const updateBusinessNameField = () => {
        const isSeller = roleSelect.value === "seller";
        businessNameField.hidden = !isSeller;
        businessNameInput.required = isSeller;
        if (businessWebsiteInput) {
            businessWebsiteInput.disabled = !isSeller;
        }
    };

    roleSelect.addEventListener("change", updateBusinessNameField);
    updateBusinessNameField();
}

const registrationForm = document.querySelector("#registration-form");
const registrationError = document.querySelector("#registration-error");

if (registrationForm && registrationError) {
    registrationForm.addEventListener("invalid", (event) => {
        registrationError.textContent = event.target.validationMessage;
        registrationError.hidden = false;
    }, true);

    registrationForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        registrationError.textContent = "";
        registrationError.hidden = true;

        const submitButton = registrationForm.querySelector('button[type="submit"]');
        const originalLabel = submitButton?.textContent || "Register";
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = "Creating account...";
        }

        let redirecting = false;
        try {
            const response = await fetch(registrationForm.action, {
                method: "POST",
                body: new URLSearchParams(new FormData(registrationForm)),
                credentials: "same-origin"
            });
            const responseUrl = new URL(response.url, window.location.href);
            const expectedPath = roleSelect?.value === "seller" ? "/seller" : "/customer";

            if (response.redirected && response.ok && responseUrl.pathname === expectedPath) {
                redirecting = true;
                window.location.assign(responseUrl.href);
                return;
            }

            if (response.redirected && responseUrl.pathname === "/login") {
                registrationError.textContent = responseUrl.searchParams.has("csrf")
                    ? "This registration form expired. Reload the page and try again."
                    : "Your account may have been created, but sign-in did not complete. Please log in with the account details you just registered.";
                registrationError.hidden = false;
                return;
            }

            const contentType = response.headers.get("content-type") || "";
            const responseText = contentType.includes("text/html")
                ? ""
                : (await response.text()).trim();
            registrationError.textContent = responseText || (
                response.status === 429
                    ? "Too many registration attempts. Please wait and try again."
                    : `We could not complete registration (HTTP ${response.status}). Please try again.`
            );
            registrationError.hidden = false;
        } catch (error) {
            console.error("Registration request failed:", error);
            registrationError.textContent = "Could not reach the marketplace. Check your connection and try again.";
            registrationError.hidden = false;
        } finally {
            if (!redirecting && submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = originalLabel;
            }
        }
    });
}

const productGrid = document.querySelector("#product-grid");
const searchInput = document.querySelector("#product-search");
const categorySelect = document.querySelector("#product-category");
const sortSelect = document.querySelector("#product-sort");
const resultsCount = document.querySelector("#results-count");
const noProductsMatch = document.querySelector("#no-products-match");

if (productGrid && searchInput && categorySelect && sortSelect) {
    const productCards = Array.from(productGrid.querySelectorAll(".product"));
    productCards.forEach((card, index) => {
        card.dataset.originalIndex = String(index);
    });

    const updateProducts = () => {
        const query = searchInput.value.trim().toLocaleLowerCase();
        const selectedCategory = categorySelect.value
            ? categorySelect.options[categorySelect.selectedIndex].text.trim().toLocaleLowerCase()
            : "";
        let visibleCount = 0;

        productCards.forEach((card) => {
            const matchesQuery = !query || card.textContent.toLocaleLowerCase().includes(query);
            const matchesCategory = !selectedCategory || card.dataset.category === selectedCategory;
            card.hidden = !matchesQuery || !matchesCategory;
            if (!card.hidden) visibleCount += 1;
        });

        const sortBy = sortSelect.value;
        const sortedCards = productCards.slice().sort((first, second) => {
            if (sortBy === "price-low") return Number(first.dataset.price) - Number(second.dataset.price);
            if (sortBy === "price-high") return Number(second.dataset.price) - Number(first.dataset.price);
            if (sortBy === "name") return first.dataset.name.localeCompare(second.dataset.name);
            return Number(first.dataset.originalIndex) - Number(second.dataset.originalIndex);
        });
        sortedCards.forEach((card) => productGrid.insertBefore(card, noProductsMatch));

        if (resultsCount) {
            resultsCount.textContent = `${visibleCount} ${visibleCount === 1 ? "product" : "products"} to explore`;
        }
        if (noProductsMatch) noProductsMatch.hidden = visibleCount > 0;
        document.querySelectorAll(".category-chip").forEach((chip) => {
            chip.setAttribute("aria-pressed", String(chip.dataset.categoryId === categorySelect.value));
        });
    };

    searchInput.addEventListener("input", updateProducts);
    categorySelect.addEventListener("change", updateProducts);
    document.querySelectorAll(".category-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            categorySelect.value = chip.dataset.categoryId;
            updateProducts();
        });
    });
    sortSelect.addEventListener("change", updateProducts);
    searchInput.form?.addEventListener("reset", () => {
        window.requestAnimationFrame(updateProducts);
    });
    updateProducts();
}

const toast = document.querySelector("#marketplace-toast");
let toastTimeout;

const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
};

document.querySelectorAll("[data-add-to-cart]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submitButton = form.querySelector('button[type="submit"]');
        if (!submitButton || submitButton.disabled) return;

        const originalLabel = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = "Adding...";

        try {
            const response = await fetch(form.action, {
                method: "POST",
                body: new URLSearchParams(new FormData(form)),
                headers: { Accept: "application/json" },
                credentials: "same-origin"
            });
            const contentType = response.headers.get("content-type") || "";
            const result = contentType.includes("application/json")
                ? await response.json()
                : { message: (await response.text()).trim() };
            if (!response.ok || !result?.success) {
                const message = result?.error || result?.message || "Could not add that item. Please try again.";
                showToast(message);
                return;
            }

            const cartLink = document.querySelector(".cart-link");
            if (cartLink) {
                let badge = cartLink.querySelector(".cart-badge");
                if (!badge) {
                    badge = document.createElement("span");
                    badge.className = "cart-badge";
                    cartLink.append(badge);
                }
                badge.textContent = String(result.cartCount);
                badge.classList.remove("is-bumped");
                void badge.offsetWidth;
                badge.classList.add("is-bumped");
                cartLink.setAttribute("aria-label", `Shopping cart, ${result.cartCount} items`);
            }

            showToast(`${result.itemName} added to your cart.`);
        } catch (error) {
            console.error("Add to cart request failed:", error);
            showToast("Could not reach the marketplace. Check your connection and try again.");
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = originalLabel;
        }
    });
});