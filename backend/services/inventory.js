async function adjustProductStock(connection, productId, quantityChange, reason) {
    if (!Number.isSafeInteger(productId) || productId <= 0 ||
        !Number.isSafeInteger(quantityChange) || quantityChange === 0) {
        throw new Error("Invalid product stock movement.");
    }

    const [products] = await connection.execute(
        "SELECT seller_id, stock FROM products WHERE id = ?",
        [productId]
    );
    const product = products[0];
    if (!product) throw new Error("Product not found during stock movement.");

    const previousStock = Number(product.stock);
    const newStock = previousStock + quantityChange;
    if (!Number.isSafeInteger(newStock) || newStock < 0 || newStock > 1000000) {
        throw new Error("Product stock movement would create an invalid quantity.");
    }

    const [result] = await connection.execute(
        "UPDATE products SET stock = ? WHERE id = ?",
        [newStock, productId]
    );
    if (!result.rowsAffected) throw new Error("Product stock update did not persist.");

    await connection.execute(
        `INSERT INTO seller_stock_movements
            (seller_id, product_id, previous_stock, new_stock, change_reason)
         VALUES (?, ?, ?, ?, ?)`,
        [product.seller_id, productId, previousStock, newStock, reason]
    );
    return newStock;
}

module.exports = { adjustProductStock };
