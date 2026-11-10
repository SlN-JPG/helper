
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} from "discord.js";

import ts from "typescript";

const TOKEN = process.env.DISCORD_TOKEN;
const CAMELOT_BOT_ID = process.env.CAMELOT_BOT_ID;

const CHARACTER_URL =
  "https://raw.githubusercontent.com/freezerfallen/Camelot2026/refs/heads/main/Modules/chars.ts";

if (!TOKEN || !CAMELOT_BOT_ID) {
  throw new Error(
    "Missing DISCORD_TOKEN or CAMELOT_BOT_ID in Secrets."
  );
}

// Normalize URLs for image matching.
function normalizeImage(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin.toLowerCase() +
      parsed.pathname
    );
  } catch {
    return url;
  }
}

// Find a variable declaration in the TypeScript source.
function findVariable(sourceFile, name) {
  let found;

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.initializer;
    }

    if (!found) {
      ts.forEachChild(node, visit);
    }
  }

  visit(sourceFile);
  return found;
}

// Read simple TypeScript expressions.
function evaluate(node, sourceFile, depth = 0, seen = new Set()) {
  if (!node || depth > 15) return undefined;

  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return evaluate(node.expression, sourceFile, depth + 1, seen);
  }

  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }

  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }

  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(element =>
      evaluate(element, sourceFile, depth + 1, seen)
    );
  }

  if (ts.isIdentifier(node)) {
    const name = node.text;

    if (seen.has(name)) return undefined;

    const initializer = findVariable(sourceFile, name);

    if (!initializer) return undefined;

    const nextSeen = new Set(seen);
    nextSeen.add(name);

    return evaluate(
      initializer,
      sourceFile,
      depth + 1,
      nextSeen
    );
  }

  if (ts.isElementAccessExpression(node)) {
    const object = evaluate(
      node.expression,
      sourceFile,
      depth + 1,
      seen
    );

    const index = node.argumentExpression
      ? evaluate(node.argumentExpression, sourceFile, depth + 1, seen)
      : undefined;

    return object?.[index];
  }

  if (ts.isPropertyAccessExpression(node)) {
    const object = evaluate(
      node.expression,
      sourceFile,
      depth + 1,
      seen
    );

    return object?.[node.name.text];
  }

  return undefined;
}

// Discover how Camelot's charInfo constructor
// maps arguments to character properties.
function getConstructorInfo(sourceFile) {
  let characterClass;

  function visit(node) {
    if (
      ts.isClassDeclaration(node) &&
      node.name?.text === "charInfo"
    ) {
      characterClass = node;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!characterClass) {
    throw new Error(
      "Could not find the charInfo class in chars.ts."
    );
  }

  const constructor = characterClass.members.find(
    ts.isConstructorDeclaration
  );

  if (!constructor) {
    throw new Error(
      "Could not find the charInfo constructor."
    );
  }

  const parameters = constructor.parameters;
  const mapping = new Map();

  // Handle public/readonly constructor properties.
  for (const parameter of parameters) {
    if (!ts.isIdentifier(parameter.name)) continue;

    const name = parameter.name.text;

    const modifiers = ts.canHaveModifiers(parameter)
      ? ts.getModifiers(parameter) ?? []
      : [];

    if (
      modifiers.some(modifier =>
        [
          ts.SyntaxKind.PublicKeyword,
          ts.SyntaxKind.PrivateKeyword,
          ts.SyntaxKind.ProtectedKeyword,
          ts.SyntaxKind.ReadonlyKeyword
        ].includes(modifier.kind)
      )
    ) {
      mapping.set(name, name);
    }
  }

  // Handle assignments such as this.name = name.
  if (constructor.body) {
    function inspect(node) {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isIdentifier(node.right)
      ) {
        mapping.set(
          node.right.text,
          node.left.name.text
        );
      }

      ts.forEachChild(node, inspect);
    }

    inspect(constructor.body);
  }

  return parameters.map(parameter => {
    if (!ts.isIdentifier(parameter.name)) {
      return null;
    }

    const name = parameter.name.text;

    return {
      argument: name,
      property: mapping.get(name) ?? name
    };
  });
}

// Convert Camelot's TypeScript database into
// ordinary JavaScript character records.
function parseCharacters(source) {
  const sourceFile = ts.createSourceFile(
    "chars.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const constructorInfo = getConstructorInfo(sourceFile);
  const characters = [];

  function visit(node) {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "charInfo"
    ) {
      const args = node.arguments ?? [];
      const record = {};

      constructorInfo.forEach((parameter, index) => {
        if (!parameter || !args[index]) return;

        record[parameter.property] = evaluate(
          args[index],
          sourceFile
        );
      });

      const name = record.name;
      const image = record.image;
      const anime = record.anime;
      const id = record.id;

      if (
        typeof name === "string" &&
        typeof image === "string" &&
        typeof anime === "string" &&
        typeof id === "number"
      ) {
        characters.push({
          name,
          image,
          anime,
          id
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (characters.length === 0) {
    throw new Error(
      "No valid characters extracted. " +
      "Check the charInfo constructor and field mappings."
    );
  }

  return characters;
}

// Download the database.
async function loadCharacters() {
  console.log("Downloading Camelot character database...");

  const response = await fetch(CHARACTER_URL);

  if (!response.ok) {
    throw new Error(
      `GitHub returned HTTP ${response.status}`
    );
  }

  const source = await response.text();

  const characters = parseCharacters(source);

  const database = new Map();

  for (const character of characters) {
    const key = normalizeImage(character.image);

    if (!database.has(key)) {
      database.set(key, []);
    }

    database.get(key).push(character);
  }

  console.log(
    `Loaded ${characters.length} characters.`
  );

  return database;
}

const imageDatabase = await loadCharacters();

// Discord client.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log("--------------------------------");
  console.log(`Logged in as ${client.user.tag}`);
  console.log("Camelot Guess Helper is online!");
  console.log("--------------------------------");
});

// Listen for Camelot's guessing messages.
client.on("messageCreate", async message => {
  try {
    // Ignore all other bots.
    if (message.author.id !== CAMELOT_BOT_ID) {
      return;
    }

    if (!message.author.bot) return;

    // Find the Guess the Character embed.
    const embed = message.embeds.find(
      item =>
        item.title?.trim().toLowerCase() ===
        "guess the character"
    );

    if (!embed) return;

    const imageUrls = [
      embed.image?.url,
      embed.image?.proxyURL
    ].filter(Boolean);

    let matches = [];

    for (const imageUrl of imageUrls) {
      matches = imageDatabase.get(
        normalizeImage(imageUrl)
      ) ?? [];

      if (matches.length > 0) break;
    }

    if (matches.length === 0) {
      console.log(
        "Unknown character image:",
        imageUrls[0] ?? "No image"
      );
      return;
    }

    // Avoid pretending a shared image is a unique match.
    const uniqueMatches = [
      ...new Map(
        matches.map(character => [
          character.id,
          character
        ])
      ).values()
    ];

    const result = new EmbedBuilder()
      .setColor(0x9B7EDD)
      .setTitle(
        uniqueMatches.length === 1
          ? "Character Identified"
          : "Possible Characters"
      )
      .setThumbnail(uniqueMatches[0].image)
      .setFooter({
        text: "Camelot Guess Helper"
      });

    if (uniqueMatches.length === 1) {
      const character = uniqueMatches[0];

      result.setDescription(
        `**Name:** ${character.name}\n` +
        `**Anime:** ${character.anime}\n` +
        `**ID:** ${character.id}`
      );

      console.log(
        `Identified: ${character.name} (#${character.id})`
      );
    } else {
      result.setDescription(
        uniqueMatches.slice(0, 10).map(character =>
          `**${character.name}** — ${character.anime} (ID: ${character.id})`
        ).join("\n")
      );

      console.log(
        `Multiple matches: ${uniqueMatches.length}`
      );
    }

    await message.reply({
      embeds: [result],
      allowedMentions: {
        repliedUser: false
      }
    });

  } catch (error) {
    console.error("Guess helper error:", error);
  }
});

// Start the bot.
client.login(TOKEN);
