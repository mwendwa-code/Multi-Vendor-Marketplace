function toPostgresSql(sql) {
    let output = "";
    let parameterIndex = 0;
    let state = "normal";
    let blockDepth = 0;
    let dollarTag = "";

    for (let index = 0; index < sql.length; index += 1) {
        const character = sql[index];
        const nextCharacter = sql[index + 1];

        if (state === "single-quoted") {
            output += character;
            if (character === "'" && nextCharacter === "'") {
                output += nextCharacter;
                index += 1;
            } else if (character === "'") {
                state = "normal";
            }
            continue;
        }

        if (state === "double-quoted") {
            output += character;
            if (character === '"' && nextCharacter === '"') {
                output += nextCharacter;
                index += 1;
            } else if (character === '"') {
                state = "normal";
            }
            continue;
        }

        if (state === "line-comment") {
            output += character;
            if (character === "\n") state = "normal";
            continue;
        }

        if (state === "block-comment") {
            output += character;
            if (character === "/" && nextCharacter === "*") {
                output += nextCharacter;
                index += 1;
                blockDepth += 1;
            } else if (character === "*" && nextCharacter === "/") {
                output += nextCharacter;
                index += 1;
                blockDepth -= 1;
                if (blockDepth === 0) state = "normal";
            }
            continue;
        }

        if (state === "dollar-quoted") {
            if (sql.startsWith(dollarTag, index)) {
                output += dollarTag;
                index += dollarTag.length - 1;
                state = "normal";
            } else {
                output += character;
            }
            continue;
        }

        if (character === "'") {
            output += character;
            state = "single-quoted";
        } else if (character === '"') {
            output += character;
            state = "double-quoted";
        } else if (character === "-" && nextCharacter === "-") {
            output += "--";
            index += 1;
            state = "line-comment";
        } else if (character === "/" && nextCharacter === "*") {
            output += "/*";
            index += 1;
            state = "block-comment";
            blockDepth = 1;
        } else if (character === "$") {
            const tag = sql.slice(index).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
            if (tag) {
                output += tag;
                index += tag.length - 1;
                dollarTag = tag;
                state = "dollar-quoted";
            } else {
                output += character;
            }
        } else if (character === "?") {
            parameterIndex += 1;
            output += `$${parameterIndex}`;
        } else {
            output += character;
        }
    }

    return { text: output, parameterCount: parameterIndex };
}

module.exports = { toPostgresSql };
