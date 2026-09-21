'use strict';
/**
 * Nexus Bot Manager — Built-in Templates
 *
 * Each template defines its metadata (name, description, difficulty,
 * dependencies, env vars, features, etc.) and a map of files that
 * are generated when a bot is created from the template.
 *
 * Files can be:
 *   - a function returning a string of source code,
 *   - a static string for plain files (e.g. .gitignore, .env.example).
 */

const TEMPLATES = [
  // ════════════════════════════════════════════════════════════════
  // Discord.js — Basic
  // ════════════════════════════════════════════════════════════════
  {
    id: 'discordjs-blank',
    name: 'Discord.js — Minimal',
    description: 'Bot Discord.js minimal mais propre. Point de départ idéal pour construire votre propre bot à partir de zéro.',
    longDescription: 'Template prêt à l\'emploi avec gestion des erreurs, intents correctement configurés et un journal de démarrage clair.',
    icon: 'ti-code',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'débutant',
    packages: ['discord.js', 'dotenv'],
    features: [
      'Connexion Discord.js v14',
      'Gestion des erreurs non capturées',
      'Configuration via .env',
      'Logs ISO 8601'
    ],
    intents: ['Guilds', 'GuildMessages', 'MessageContent'],
    envVars: [
      { key: 'TOKEN', label: 'Token Discord', required: true, secret: true, hint: 'Obtenu sur discord.com/developers > Bot' }
    ],
    files: {
      'index.js': () => `'use strict';
require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, (c) => {
  console.log(\`[\${new Date().toISOString()}] ✅ Connecté en tant que \${c.user.tag}\`);
});

client.on(Events.Error, (err) => {
  console.error(\`[\${new Date().toISOString()}] ❌ Erreur Discord.js :\`, err);
});

process.on('unhandledRejection', (error) => {
  console.error(\`[\${new Date().toISOString()}] ❌ Promesse non gérée :\`, error);
});

process.on('uncaughtException', (error) => {
  console.error(\`[\${new Date().toISOString()}] ❌ Exception non capturée :\`, error);
});

if (!process.env.TOKEN) {
  console.error('[FATAL] La variable TOKEN est manquante dans le fichier .env');
  process.exit(1);
}

client.login(process.env.TOKEN);
`,
      '.env.example': `# Copiez ce fichier en \`.env\` puis remplissez les valeurs.

# Token de votre bot Discord (https://discord.com/developers/applications)
TOKEN=
`,
      'README.md': () => `# Bot Discord.js — Minimal

Bot Discord simple prêt à l'emploi.

## Installation

\`\`\`bash
npm install
\`\`\`

## Configuration

1. Copiez \`.env.example\` en \`.env\`
2. Renseignez votre \`TOKEN\` Discord
3. Activez l'intent **Message Content** dans le portail développeur Discord

## Démarrage

\`\`\`bash
npm start
\`\`\`

Géré par [Nexus Bot Manager](https://github.com/Julien48003/nexus-bot-manager).
`
    }
  },

  // ════════════════════════════════════════════════════════════════
  // Discord.js — Slash Commands (kept, refined)
  // ════════════════════════════════════════════════════════════════
  {
    id: 'discordjs-slash',
    name: 'Discord.js — Slash Commands',
    description: 'Architecture complète avec chargement automatique des commandes slash, événements et déploiement.',
    longDescription: 'Template avancé pour bots sérieux : structure modulaire (commands/, events/), déploiement des commandes REST, gestion propre des erreurs et replies éphémères.',
    icon: 'ti-terminal-2',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'intermédiaire',
    packages: ['discord.js', 'dotenv'],
    features: [
      'Architecture modulaire commands/events',
      'Chargement automatique depuis le disque',
      'Script de déploiement REST inclus',
      'Commandes guild + globales',
      'Gestion propre des erreurs'
    ],
    intents: ['Guilds', 'GuildMessages', 'MessageContent'],
    envVars: [
      { key: 'TOKEN',     label: 'Token Discord',  required: true,  secret: true },
      { key: 'CLIENT_ID', label: 'Application ID', required: true,  secret: false, hint: 'ID de votre application Discord' },
      { key: 'GUILD_ID',  label: 'ID du serveur',  required: false, secret: false, hint: 'Laisser vide pour déploiement global (jusqu\'à 1h de propagation)' }
    ],
    files: {
      'index.js': () => `'use strict';
require('dotenv').config();
const { Client, GatewayIntentBits, Events, Collection } = require('discord.js');
const fs   = require('node:fs');
const path = require('node:path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.commands = new Collection();

const cmdPath = path.join(__dirname, 'commands');
if (fs.existsSync(cmdPath)) {
  for (const file of fs.readdirSync(cmdPath).filter(f => f.endsWith('.js'))) {
    const cmd = require(path.join(cmdPath, file));
    if ('data' in cmd && 'execute' in cmd) client.commands.set(cmd.data.name, cmd);
  }
}

const evtPath = path.join(__dirname, 'events');
if (fs.existsSync(evtPath)) {
  for (const file of fs.readdirSync(evtPath).filter(f => f.endsWith('.js'))) {
    const evt = require(path.join(evtPath, file));
    if (!evt?.name || typeof evt.execute !== 'function') continue;
    if (evt.once) client.once(evt.name, (...args) => evt.execute(...args, client));
    else          client.on(evt.name,    (...args) => evt.execute(...args, client));
  }
}

client.on(Events.Error, (err) => console.error('[discord.js]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

if (!process.env.TOKEN) { console.error('[FATAL] TOKEN manquant'); process.exit(1); }

client.login(process.env.TOKEN);
`,
      'commands/ping.js': () => `const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Affiche la latence du bot et de l\'API Discord.'),
  async execute(interaction) {
    const sent = await interaction.reply({ content: 'Calcul…', fetchReply: true, ephemeral: true });
    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    const ws = Math.round(interaction.client.ws.ping);
    await interaction.editReply(\`🏓 Pong ! Aller-retour : \${roundtrip}ms · WS : \${ws}ms\`);
  }
};
`,
      'commands/help.js': () => `const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Affiche la liste des commandes disponibles.'),
  async execute(interaction) {
    const cmds = interaction.client.commands.map(c => \`\`\`\${c.data.name}\`\`\` — \${c.data.description}\`);
    const embed = new EmbedBuilder()
      .setTitle('Commandes disponibles')
      .setDescription(cmds.join('\\n') || 'Aucune commande.')
      .setColor(0x2563eb);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};
`,
      'events/ready.js': () => `const { Events } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(\`[\${new Date().toISOString()}] ✅ \${client.user.tag} prêt — \${client.commands.size} commande(s) chargée(s)\`);
    client.user.setPresence({ status: 'online', activities: [{ name: '/help', type: 3 }] });
  }
};
`,
      'events/interactionCreate.js': () => `const { Events, MessageFlags } = require('discord.js');

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(\`[command:\${interaction.commandName}]\`, error);
      const payload = { content: '❌ Une erreur est survenue lors de l\\'exécution de la commande.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  }
};
`,
      'deploy-commands.js': () => `'use strict';
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs   = require('node:fs');
const path = require('node:path');

const commands = [];
const cmdPath  = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(cmdPath).filter(f => f.endsWith('.js'))) {
  const cmd = require(path.join(cmdPath, file));
  if ('data' in cmd) commands.push(cmd.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log(\`Déploiement de \${commands.length} commande(s)…\`);
    if (!process.env.CLIENT_ID) throw new Error('CLIENT_ID manquant dans .env');

    if (process.env.GUILD_ID) {
      const data = await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(\`✅ \${data.length} commande(s) déployée(s) sur le serveur \${process.env.GUILD_ID}\`);
    } else {
      const data = await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log(\`✅ \${data.length} commande(s) déployée(s) globalement (propagation jusqu'à 1h)\`);
    }
  } catch (err) {
    console.error('[deploy]', err);
    process.exit(1);
  }
})();
`,
      '.env.example': `# Copiez ce fichier en \`.env\` puis remplissez les valeurs.

# Token du bot (https://discord.com/developers/applications)
TOKEN=

# ID de l'application (visible dans l'onglet General Information)
CLIENT_ID=

# ID du serveur pour déployer rapidement les commandes (optionnel)
# Laisser vide pour un déploiement global
GUILD_ID=
`,
      'README.md': () => `# Bot Discord.js — Slash Commands

Architecture professionnelle pour un bot Discord basé sur les commandes slash.

## Structure

\`\`\`
├── commands/        # Une commande par fichier
│   ├── ping.js
│   └── help.js
├── events/          # Un événement par fichier
│   ├── ready.js
│   └── interactionCreate.js
├── index.js         # Point d'entrée
├── deploy-commands.js   # Déploie les commandes sur Discord
└── .env
\`\`\`

## Installation

\`\`\`bash
npm install
cp .env.example .env   # Puis remplissez TOKEN, CLIENT_ID, GUILD_ID
\`\`\`

## Déploiement des commandes

\`\`\`bash
node deploy-commands.js
\`\`\`

## Démarrage

\`\`\`bash
npm start
\`\`\`

Géré par [Nexus Bot Manager](https://github.com/Julien48003/nexus-bot-manager).
`
    }
  },

  // ════════════════════════════════════════════════════════════════
  // Discord.js — Verification Bot (NEW)
  // ════════════════════════════════════════════════════════════════
  {
    id: 'discordjs-verification',
    name: 'Discord.js — Vérification & Règles',
    description: 'Système de vérification avec acceptation des règles. Attribution automatique d\'un rôle Membre et retrait du rôle Non vérifié.',
    longDescription: 'Affiche un embed avec les règles dans un salon dédié. L\'utilisateur clique sur « J\'accepte », reçoit le rôle configuré et accède au serveur. Gestion propre des erreurs de permissions Discord.',
    icon: 'ti-shield-check',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'débutant',
    packages: ['discord.js', 'dotenv'],
    features: [
      'Embed de règles paramétrable',
      'Bouton « J\'accepte »',
      'Attribution d\'un rôle vérifié',
      'Retrait optionnel du rôle non vérifié',
      'Logs de vérification',
      'Gestion des erreurs de permissions'
    ],
    intents: ['Guilds', 'GuildMembers'],
    envVars: [
      { key: 'TOKEN',                label: 'Token Discord',                  required: true,  secret: true },
      { key: 'VERIFY_CHANNEL_ID',    label: 'Salon de vérification',          required: true,  secret: false },
      { key: 'MEMBER_ROLE_ID',       label: 'Rôle Membre (à attribuer)',     required: true,  secret: false },
      { key: 'UNVERIFIED_ROLE_ID',   label: 'Rôle Non vérifié (à retirer)',  required: false, secret: false },
      { key: 'LOG_CHANNEL_ID',       label: 'Salon de logs',                  required: false, secret: false }
    ],
    files: {
      'index.js': (ctx) => {
        const S = ctx.strings;
        const RULES_BY_LANG = {
          en: [
            '1. Respect all members. No harassment, insults or discrimination.',
            '2. No spam, flooding or unauthorized advertising.',
            '3. Use the right channels for the right discussions.',
            '4. Staff decisions are final.',
            '5. Any inappropriate content (NSFW, gore, doxxing) is strictly prohibited.'
          ],
          fr: [
            '1. Respectez tous les membres. Aucun harcèlement, insulte ou discrimination.',
            '2. Pas de spam, flood ou publicité non autorisée.',
            '3. Utilisez les bons salons pour les bonnes discussions.',
            '4. Les décisions du staff sont définitives.',
            '5. Tout contenu inapproprié (NSFW, gore, doxxing) est strictement interdit.'
          ],
          de: [
            '1. Respektiere alle Mitglieder. Keine Belästigung, Beleidigung oder Diskriminierung.',
            '2. Kein Spam, Flooding oder unautorisierte Werbung.',
            '3. Nutze die richtigen Kanäle für die richtigen Diskussionen.',
            '4. Entscheidungen des Teams sind endgültig.',
            '5. Unangemessene Inhalte (NSFW, Gewalt, Doxxing) sind strengstens verboten.'
          ]
        };
        const rules = RULES_BY_LANG[ctx.language] || RULES_BY_LANG.en;
        const TITLES = { en: '📜 Server rules', fr: '📜 Règles du serveur', de: '📜 Serverregeln' };
        const DESCS  = { en: 'Read the rules and click **I accept** to access the rest of the server.',
                          fr: 'Pour accéder au reste du serveur, lisez les règles puis cliquez sur **J\'accepte**.',
                          de: 'Lies die Regeln und klicke auf **Ich akzeptiere**, um den Rest des Servers zu betreten.' };
        const NAMES  = { en: 'Rules', fr: 'Règles', de: 'Regeln' };
        const BTNS   = { en: 'I accept', fr: 'J\'accepte', de: 'Ich akzeptiere' };
        const FOOTS  = { en: 'By clicking, you accept these rules.', fr: 'En cliquant, vous acceptez ces règles.', de: 'Mit dem Klick akzeptierst du diese Regeln.' };
        const WELCS  = { en: (g) => `✅ Welcome to **${g}**!`,
                          fr: (g) => `✅ Bienvenue sur **${g}** !`,
                          de: (g) => `✅ Willkommen auf **${g}**!` };
        const LOGS   = { en: '✅ Member verified', fr: '✅ Membre vérifié', de: '✅ Mitglied verifiziert' };
        const ERR_NOT_FOUND = {
          en: '❌ Verified role not found. Contact an administrator.',
          fr: '❌ Rôle vérifié introuvable. Contactez un administrateur.',
          de: '❌ Verifizierte Rolle nicht gefunden. Wende dich an einen Administrator.'
        };
        const ERR_PERMS = {
          en: '❌ Insufficient permissions. Make sure the bot role is above the managed roles.',
          fr: '❌ Permissions insuffisantes. Vérifiez que le rôle du bot est au-dessus des rôles gérés.',
          de: '❌ Unzureichende Berechtigungen. Stelle sicher, dass die Bot-Rolle über den verwalteten Rollen liegt.'
        };
        const ERR_GENERIC = {
          en: '❌ An error occurred during verification.',
          fr: '❌ Une erreur est survenue lors de la vérification.',
          de: '❌ Bei der Überprüfung ist ein Fehler aufgetreten.'
        };
        const READY_TITLE = { en: 'Verification active', fr: 'Vérification active', de: 'Verifizierung aktiv' };
        const LOG_BODY = {
          en: (user) => `${user.tag} (${user.id}) has accepted the rules.`,
          fr: (user) => `${user.tag} (${user.id}) a accepté les règles.`,
          de: (user) => `${user.tag} (${user.id}) hat die Regeln akzeptiert.`
        };
        const WELC = {
          en: '✅ Welcome to **__GUILD__**, __MEMBER__ !',
          fr: '✅ Bienvenue sur **__GUILD__**, __MEMBER__ !',
          de: '✅ Willkommen auf **__GUILD__**, __MEMBER__ !'
        };
        const FATAL    = { en: '[FATAL] TOKEN missing',      fr: '[FATAL] TOKEN manquant',  de: '[FATAL] TOKEN fehlt' };
        const SEND_PANEL_ERR = { en: 'Panel send:', fr: 'Envoi panneau :', de: 'Panel-Versand:' };
        const LANG = ctx.language;

        return `'use strict';
require('dotenv').config();
const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

const RULES = ${JSON.stringify(rules)};

const LANG = ${JSON.stringify(LANG)};
const WELC = ${JSON.stringify(WELC)};
const FATAL = ${JSON.stringify(FATAL)};
const SEND_PANEL_ERR = ${JSON.stringify(SEND_PANEL_ERR)};
const READY_TITLE = ${JSON.stringify(READY_TITLE)};
const LOG_BODY = {
  en: (user) => \`\${user.tag} (\${user.id}) has accepted the rules.\`,
  fr: (user) => \`\${user.tag} (\${user.id}) a accepté les règles.\`,
  de: (user) => \`\${user.tag} (\${user.id}) hat die Regeln akzeptiert.\`
};

function buildVerifyEmbed() {
  return new EmbedBuilder()
    .setTitle(${JSON.stringify(TITLES[LANG])})
    .setDescription(${JSON.stringify(DESCS[LANG])})
    .addFields({ name: ${JSON.stringify(NAMES[LANG])}, value: RULES.join('\\n\\n') })
    .setColor(0x2563eb)
    .setFooter({ text: ${JSON.stringify(FOOTS[LANG])} })
    .setTimestamp();
}

async function sendVerifyPanel(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify_accept').setLabel(${JSON.stringify(BTNS[LANG])}).setStyle(ButtonStyle.Success).setEmoji('✅')
  );
  await channel.send({ embeds: [buildVerifyEmbed()], components: [row] });
}

async function logVerification(guild, user) {
  if (!process.env.LOG_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setTitle(${JSON.stringify(LOGS[LANG])})
    .setDescription(LOG_BODY[LANG](user))
    .setColor(0x16a34a).setTimestamp();
  await ch.send({ embeds: [embed] }).catch(() => {});
}

client.once(Events.ClientReady, async (c) => {
  console.log(\`[\${new Date().toISOString()}] ✅ \${c.user.tag} — \${READY_TITLE[LANG]}\`);
  if (process.env.VERIFY_CHANNEL_ID) {
    const channel = c.channels.cache.get(process.env.VERIFY_CHANNEL_ID);
    if (channel) await sendVerifyPanel(channel).catch(err => console.error(\`\${SEND_PANEL_ERR[LANG]} \${err.message}\`));
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== 'verify_accept') return;

  const member = interaction.member;
  const guild  = interaction.guild;

  try {
    if (process.env.MEMBER_ROLE_ID) {
      const role = guild.roles.cache.get(process.env.MEMBER_ROLE_ID);
      if (!role) return interaction.reply({ content: ${JSON.stringify(ERR_NOT_FOUND[LANG])}, flags: MessageFlags.Ephemeral });
      await member.roles.add(role);
    }
    if (process.env.UNVERIFIED_ROLE_ID) {
      const role = guild.roles.cache.get(process.env.UNVERIFIED_ROLE_ID);
      if (role && member.roles.cache.has(role.id)) await member.roles.remove(role).catch(() => {});
    }
    await interaction.reply({ content: WELC[LANG].replace('__GUILD__', guild.name).replace('__MEMBER__', String(member)), flags: MessageFlags.Ephemeral });
    await logVerification(guild, member.user);
  } catch (err) {
    console.error('[verify]', err);
    const msg = err.code === 50013
      ? ${JSON.stringify(ERR_PERMS[LANG])}
      : ${JSON.stringify(ERR_GENERIC[LANG])};
    if (!interaction.replied) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
if (!process.env.TOKEN) { console.error(FATAL[LANG]); process.exit(1); }
client.login(process.env.TOKEN);
`;
      },
      '.env.example': `TOKEN=
VERIFY_CHANNEL_ID=
MEMBER_ROLE_ID=
UNVERIFIED_ROLE_ID=
LOG_CHANNEL_ID=
`,
      'README.md': () => `# Bot Discord — Vérification & Règles

Affiche un panneau avec les règles du serveur. Lorsqu'un membre clique sur **J'accepte**, il reçoit automatiquement le rôle configuré et perd le rôle "Non vérifié" s'il existe.

## Configuration requise

1. **Activez l'intent Server Members** dans le portail développeur Discord.
2. Créez deux rôles :
   - \`MEMBER_ROLE_ID\` : rôle à donner aux membres vérifiés
   - \`UNVERIFIED_ROLE_ID\` (optionnel) : rôle à retirer
3. Créez un salon de vérification où le bot enverra le panneau.
4. Placez le rôle du bot **au-dessus** des rôles qu'il doit gérer.

## Variables

| Variable | Description |
|----------|-------------|
| \`TOKEN\`              | Token du bot |
| \`VERIFY_CHANNEL_ID\`  | Salon d'envoi du panneau |
| \`MEMBER_ROLE_ID\`    | Rôle à attribuer |
| \`UNVERIFIED_ROLE_ID\`| Rôle à retirer (optionnel) |
| \`LOG_CHANNEL_ID\`    | Salon pour les logs de vérification |

Géré par [Nexus Bot Manager](https://github.com/Julien48003/nexus-bot-manager).
`
    }
  },

  // ════════════════════════════════════════════════════════════════
  // Discord.js — Welcome Bot (NEW)
  // ════════════════════════════════════════════════════════════════
  {
    id: 'discordjs-welcome',
    name: 'Discord.js — Accueil & Onboarding',
    description: 'Bot d\'accueil avec message de bienvenue, attribution automatique de rôle, message de départ et compteur de membres.',
    longDescription: 'Accueille chaque nouveau membre avec un embed personnalisé configurable, attribue automatiquement un rôle et gère les départs. Évite les répétitions et gère proprement les erreurs Discord.',
    icon: 'ti-door-enter',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'débutant',
    packages: ['discord.js', 'dotenv'],
    features: [
      'Embed de bienvenue avec avatar',
      'Attribution automatique de rôle',
      'Message de départ',
      'Compteur de membres',
      'Gestion des erreurs de permissions'
    ],
    intents: ['Guilds', 'GuildMembers'],
    envVars: [
      { key: 'TOKEN',              label: 'Token Discord',        required: true,  secret: true },
      { key: 'WELCOME_CHANNEL_ID', label: 'Salon de bienvenue',   required: true,  secret: false },
      { key: 'LEAVE_CHANNEL_ID',   label: 'Salon de départ',      required: false, secret: false },
      { key: 'MEMBER_ROLE_ID',     label: 'Rôle à attribuer',     required: false, secret: false },
      { key: 'WELCOME_COLOR',      label: 'Couleur (hex, défaut 0x2563eb)', required: false, secret: false }
    ],
    files: {
      'index.js': () => `'use strict';
require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

const color = (() => {
  const raw = process.env.WELCOME_COLOR || '0x2563eb';
  const n = parseInt(String(raw).replace('#','').replace('0x',''), 16);
  return Number.isFinite(n) ? n : 0x2563eb;
})();

client.once(Events.ClientReady, (c) => {
  console.log(\`[\${new Date().toISOString()}] ✅ \${c.user.tag} — Accueil actif\`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(\`👋 Bienvenue sur \${member.guild.name} !\`)
    .setDescription(
      \`Salut \${member}, nous sommes ravis de t'accueillir parmi nous !\\n\\n` +
      `Tu es le **\${member.guild.memberCount}<sup>ème</sup>** membre 🎉\\n\\n` +
      `N'hésite pas à lire les règles et à te présenter.\`
    )
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setColor(color)
    .setTimestamp();

  try {
    await channel.send({ content: \`\${member}\`, embeds: [embed] });
  } catch (err) { console.error('[welcome]', err); }

  if (process.env.MEMBER_ROLE_ID) {
    const role = member.guild.roles.cache.get(process.env.MEMBER_ROLE_ID);
    if (role) await member.roles.add(role).catch(err => console.error('[role]', err.message));
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  if (!process.env.LEAVE_CHANNEL_ID) return;
  const channel = member.guild.channels.cache.get(process.env.LEAVE_CHANNEL_ID);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setDescription(\`👋 **\${member.user.tag}** a quitté le serveur. Nous sommes désormais **\${member.guild.memberCount}** membres.\`)
    .setColor(0x6b7280).setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => {});
});

process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
if (!process.env.TOKEN) { console.error('[FATAL] TOKEN manquant'); process.exit(1); }
client.login(process.env.TOKEN);
`,
      '.env.example': `TOKEN=
WELCOME_CHANNEL_ID=
LEAVE_CHANNEL_ID=
MEMBER_ROLE_ID=
WELCOME_COLOR=0x2563eb
`,
      'README.md': () => `# Bot Discord — Accueil & Onboarding

Accueille automatiquement chaque nouveau membre, attribue un rôle et informe des départs.

## Configuration Discord

1. Activez l'intent **Server Members**.
2. Créez les salons \`#bienvenue\` et \`#départs\`.
3. Créez un rôle (par ex. *Membre*) à attribuer automatiquement.

## Variables

| Variable | Description |
|----------|-------------|
| \`TOKEN\`               | Token du bot |
| \`WELCOME_CHANNEL_ID\`  | Salon d'accueil |
| \`LEAVE_CHANNEL_ID\`    | Salon de départ (optionnel) |
| \`MEMBER_ROLE_ID\`      | Rôle à attribuer (optionnel) |
| \`WELCOME_COLOR\`       | Couleur de l'embed (hex, défaut bleu) |

Géré par [Nexus Bot Manager](https://github.com/Julien48003/nexus-bot-manager).
`
    }
  },

  // ════════════════════════════════════════════════════════════════
  // Discord.js — Tickets Support (NEW)
  // ════════════════════════════════════════════════════════════════
  {
    id: 'discordjs-tickets',
    name: 'Discord.js — Tickets Support',
    description: 'Système de tickets avec bouton, salons privés, permissions staff, fermeture et logs.',
    longDescription: 'Le membre clique sur « Ouvrir un ticket » et un salon privé est créé automatiquement. Permissions correctement configurées, bouton de fermeture et logs détaillés.',
    icon: 'ti-ticket',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'intermédiaire',
    packages: ['discord.js', 'dotenv'],
    features: [
      'Bouton d\'ouverture de ticket',
      'Création automatique de salon privé',
      'Permissions staff automatiques',
      'Bouton de fermeture',
      'Logs de tickets',
      'Anti-doublon : 1 ticket ouvert par utilisateur'
    ],
    intents: ['Guilds'],
    envVars: [
      { key: 'TOKEN',            label: 'Token Discord',     required: true,  secret: true },
      { key: 'TICKET_CHANNEL_ID',label: 'Salon panneau',     required: true,  secret: false },
      { key: 'CATEGORY_ID',      label: 'Catégorie parente', required: false, secret: false, hint: 'Les tickets y seront créés' },
      { key: 'STAFF_ROLE_ID',    label: 'Rôle support',      required: false, secret: false },
      { key: 'LOG_CHANNEL_ID',   label: 'Salon de logs',     required: false, secret: false }
    ],
    files: {
      'index.js': () => `'use strict';
require('dotenv').config();
const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const openTickets = new Map(); // userId -> channelId

async function logTicket(guild, embed) {
  if (!process.env.LOG_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

async function postPanel(channel) {
  const embed = new EmbedBuilder()
    .setTitle('🎫 Support')
    .setDescription('Besoin d\\'aide ? Cliquez sur le bouton ci-dessous pour ouvrir un ticket privé avec le staff.')
    .setColor(0x2563eb).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_open').setLabel('Ouvrir un ticket').setStyle(ButtonStyle.Primary).setEmoji('🎫')
  );
  await channel.send({ embeds: [embed], components: [row] });
}

client.once(Events.ClientReady, async (c) => {
  console.log(\`[\${new Date().toISOString()}] ✅ \${c.user.tag} — Tickets actifs\`);
  if (process.env.TICKET_CHANNEL_ID) {
    const ch = c.channels.cache.get(process.env.TICKET_CHANNEL_ID);
    if (ch) await postPanel(ch).catch(err => console.error('[panel]', err.message));
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const guild = interaction.guild;

  if (interaction.customId === 'ticket_open') {
    if (openTickets.has(interaction.user.id)) {
      return interaction.reply({ content: \`❌ Vous avez déjà un ticket ouvert : <#\${openTickets.get(interaction.user.id)}>\`, flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const perms = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] }
      ];
      if (process.env.STAFF_ROLE_ID) {
        perms.push({ id: process.env.STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] });
      }
      const botMember = guild.members.me;
      if (botMember) perms.push({ id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] });

      const ch = await guild.channels.create({
        name: \`ticket-\${interaction.user.username}\`.toLowerCase().slice(0, 90),
        type: ChannelType.GuildText,
        parent: process.env.CATEGORY_ID || null,
        permissionOverwrites: perms,
        reason: \`Ticket ouvert par \${interaction.user.tag}\`
      });
      openTickets.set(interaction.user.id, ch.id);

      const embed = new EmbedBuilder()
        .setTitle(\`Ticket de \${interaction.user.tag}\`)
        .setDescription('Un membre du staff vous répondra bientôt. Décrivez votre demande avec précision.')
        .setColor(0x2563eb).setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('Fermer le ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
      );
      await ch.send({ content: \`\${interaction.user}\`, embeds: [embed], components: [row] });

      await logTicket(guild, new EmbedBuilder()
        .setTitle('🎫 Ticket ouvert')
        .setDescription(\`\${interaction.user.tag} (\${interaction.user.id}) — <#\${ch.id}>\`)
        .setColor(0x16a34a).setTimestamp());

      await interaction.editReply({ content: \`✅ Ticket créé : \${ch}\` });
    } catch (err) {
      console.error('[ticket open]', err);
      await interaction.editReply({ content: '❌ Impossible de créer le ticket. Vérifiez les permissions du bot.' }).catch(() => {});
    }
  }

  if (interaction.customId === 'ticket_close') {
    const userId = [...openTickets.entries()].find(([, cid]) => cid === interaction.channelId)?.[0];
    await interaction.reply('🔒 Fermeture du ticket…');
    await logTicket(guild, new EmbedBuilder()
      .setTitle('🔒 Ticket fermé')
      .setDescription(\`Salon : <#\${interaction.channelId}> · Fermé par \${interaction.user.tag}\`)
      .setColor(0x6b7280).setTimestamp());
    if (userId) openTickets.delete(userId);
    setTimeout(() => interaction.channel?.delete().catch(() => {}), 1500);
  }
});

process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
if (!process.env.TOKEN) { console.error('[FATAL] TOKEN manquant'); process.exit(1); }
client.login(process.env.TOKEN);
`,
      '.env.example': `TOKEN=
TICKET_CHANNEL_ID=
CATEGORY_ID=
STAFF_ROLE_ID=
LOG_CHANNEL_ID=
`,
      'README.md': () => `# Bot Discord — Tickets Support

Système de tickets simple : un bouton ouvre un salon privé entre l'utilisateur et le staff.

## Configuration Discord

1. Créez un salon \`#tickets\` (le bot y enverra le panneau).
2. Créez une catégorie "Tickets" — les salons de tickets y seront créés.
3. Créez un rôle \`Support\` qui aura accès aux tickets.
4. Le bot doit avoir les permissions : *Gérer les salons*, *Voir les salons*, *Envoyer des messages*.

## Variables

| Variable | Description |
|----------|-------------|
| \`TOKEN\`              | Token du bot |
| \`TICKET_CHANNEL_ID\` | Salon du panneau |
| \`CATEGORY_ID\`       | Catégorie parente (optionnel) |
| \`STAFF_ROLE_ID\`     | Rôle staff avec accès aux tickets |
| \`LOG_CHANNEL_ID\`    | Logs d'ouverture/fermeture |

Géré par [Nexus Bot Manager](https://github.com/Julien48003/nexus-bot-manager).
`
    }
  },

  // ════════════════════════════════════════════════════════════════
  // Discord.js — Moderation (NEW - slash based)
  // ════════════════════════════════════════════════════════════════
  {
    id: 'discordjs-moderation',
    name: 'Discord.js — Modération',
    description: 'Commandes slash de modération : /warn /mute /kick /ban /clear avec logs détaillés et permissions strictes.',
    longDescription: 'Toutes les commandes utilisent les permissions natives Discord (pas de rôle custom). Chaque action est loggée dans un salon dédié avec un embed professionnel.',
    icon: 'ti-shield',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'intermédiaire',
    packages: ['discord.js', 'dotenv'],
    features: [
      'Commandes slash natives',
      'Vérification des permissions Discord',
      'Logs embed pour chaque action',
      '/warn avec compteur persistant',
      '/mute avec timeout Discord',
      '/clear avec gestion d\'ancienneté 14j'
    ],
    intents: ['Guilds', 'GuildMessages', 'GuildMembers', 'MessageContent'],
    envVars: [
      { key: 'TOKEN',              label: 'Token Discord',          required: true,  secret: true },
      { key: 'CLIENT_ID',          label: 'Application ID',         required: true,  secret: false },
      { key: 'GUILD_ID',           label: 'ID du serveur',          required: false, secret: false },
      { key: 'MOD_LOG_CHANNEL_ID', label: 'Salon de logs modération', required: true, secret: false }
    ],
    files: {
      'index.js': () => `'use strict';
require('dotenv').config();
const { Client, GatewayIntentBits, Events, Collection, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const fs   = require('node:fs');
const path = require('node:path');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]
});

client.commands = new Collection();
const cmdPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(cmdPath).filter(f => f.endsWith('.js'))) {
  const cmd = require(path.join(cmdPath, file));
  if ('data' in cmd && 'execute' in cmd) client.commands.set(cmd.data.name, cmd);
}

const evtPath = path.join(__dirname, 'events');
for (const file of fs.readdirSync(evtPath).filter(f => f.endsWith('.js'))) {
  const evt = require(path.join(evtPath, file));
  if (evt.once) client.once(evt.name, (...a) => evt.execute(...a, client));
  else          client.on(evt.name,    (...a) => evt.execute(...a, client));
}

process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
if (!process.env.TOKEN) { console.error('[FATAL] TOKEN manquant'); process.exit(1); }
client.login(process.env.TOKEN);
`,
      'events/ready.js': () => `const { Events } = require('discord.js');
module.exports = {
  name: Events.ClientReady, once: true,
  execute(client) {
    console.log(\`[\${new Date().toISOString()}] ✅ \${client.user.tag} — Modération active (\${client.commands.size} cmd)\`);
  }
};
`,
      'events/interactionCreate.js': () => `const { Events, MessageFlags } = require('discord.js');
module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(\`[cmd:\${interaction.commandName}]\`, err);
      const payload = { content: '❌ Une erreur est survenue.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(()=>{});
      else await interaction.reply(payload).catch(()=>{});
    }
  }
};
`,
      'commands/warn.js': () => `const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const fs   = require('node:fs');
const path = require('node:path');
const FILE = path.join(__dirname, '..', 'data', 'warns.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function save(d) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn').setDescription('Avertir un membre.')
    .addUserOption(o => o.setName('utilisateur').setDescription('Membre à avertir').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison de l\\'avertissement').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  async execute(interaction) {
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison') || 'Aucune raison fournie';

    if (target.bot) return interaction.reply({ content: '❌ Impossible d\\'avertir un bot.', flags: MessageFlags.Ephemeral });
    if (target.id === interaction.user.id) return interaction.reply({ content: '❌ Vous ne pouvez pas vous avertir vous-même.', flags: MessageFlags.Ephemeral });

    const db = load(); const key = \`\${interaction.guild.id}-\${target.id}\`;
    db[key] = db[key] || []; db[key].push({ mod: interaction.user.tag, reason, at: new Date().toISOString() });
    save(db);

    const logCh = interaction.guild.channels.cache.get(process.env.MOD_LOG_CHANNEL_ID);
    if (logCh) {
      const embed = new EmbedBuilder()
        .setTitle('⚠️ Avertissement')
        .addFields(
          { name: 'Membre',     value: \`\${target.tag} (\${target.id})\`, inline: true },
          { name: 'Modérateur', value: interaction.user.tag,               inline: true },
          { name: 'Raison',     value: reason },
          { name: 'Total warns',value: String(db[key].length) }
        ).setColor(0xd97706).setTimestamp();
      await logCh.send({ embeds: [embed] }).catch(()=>{});
    }
    await interaction.reply({ content: \`✅ **\${target.tag}** averti. Total : \${db[key].length}\`, flags: MessageFlags.Ephemeral });
  }
};
`,
      'commands/mute.js': () => `const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mute').setDescription('Mute temporairement un membre (timeout).')
    .addUserOption(o => o.setName('utilisateur').setDescription('Membre à mute').setRequired(true))
    .addIntegerOption(o => o.setName('duree').setDescription('Durée en minutes (max 4032 = 28 jours)').setMinValue(1).setMaxValue(4032).setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  async execute(interaction) {
    const target = interaction.options.getMember('utilisateur');
    const minutes = interaction.options.getInteger('duree', true);
    const reason = interaction.options.getString('raison') || 'Aucune raison';

    if (!target) return interaction.reply({ content: '❌ Membre introuvable.', flags: MessageFlags.Ephemeral });
    if (target.id === interaction.user.id) return interaction.reply({ content: '❌ Vous ne pouvez pas vous mute vous-même.', flags: MessageFlags.Ephemeral });

    try {
      await target.timeout(minutes * 60_000, reason);
      await interaction.reply({ content: \`✅ **\${target.user.tag}** mute pour **\${minutes} min** — \${reason}\`, flags: MessageFlags.Ephemeral });

      const logCh = interaction.guild.channels.cache.get(process.env.MOD_LOG_CHANNEL_ID);
      if (logCh) {
        const { EmbedBuilder } = require('discord.js');
        await logCh.send({ embeds: [new EmbedBuilder()
          .setTitle('🔇 Mute')
          .addFields(
            { name: 'Membre',     value: \`\${target.user.tag} (\${target.user.id})\`, inline: true },
            { name: 'Modérateur', value: interaction.user.tag,                       inline: true },
            { name: 'Durée',      value: \`\${minutes} min\`, inline: true },
            { name: 'Raison',     value: reason }
          ).setColor(0xd97706).setTimestamp()]}).catch(()=>{});
      }
    } catch (err) {
      const msg = err.code === 50013 ? '❌ Permissions insuffisantes (le rôle du bot doit être plus haut).' : '❌ Erreur : ' + err.message;
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
  }
};
`,
      'commands/kick.js': () => `const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick').setDescription('Expulse un membre du serveur.')
    .addUserOption(o => o.setName('utilisateur').setDescription('Membre à expulser').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  async execute(interaction) {
    const target = interaction.options.getMember('utilisateur');
    const reason = interaction.options.getString('raison') || 'Aucune raison';
    if (!target) return interaction.reply({ content: '❌ Membre introuvable.', flags: MessageFlags.Ephemeral });
    if (target.id === interaction.user.id) return interaction.reply({ content: '❌ Vous ne pouvez pas vous expulser vous-même.', flags: MessageFlags.Ephemeral });

    try {
      await target.kick(reason);
      await interaction.reply({ content: \`✅ **\${target.user.tag}** expulsé — \${reason}\`, flags: MessageFlags.Ephemeral });
      const logCh = interaction.guild.channels.cache.get(process.env.MOD_LOG_CHANNEL_ID);
      if (logCh) await logCh.send({ embeds: [new EmbedBuilder().setTitle('👢 Kick')
        .addFields({ name:'Membre', value:\`\${target.user.tag} (\${target.user.id})\`}, { name:'Modérateur', value:interaction.user.tag }, { name:'Raison', value:reason })
        .setColor(0xd97706).setTimestamp()]}).catch(()=>{});
    } catch (err) {
      const msg = err.code === 50013 ? '❌ Permissions insuffisantes.' : '❌ Erreur : ' + err.message;
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
  }
};
`,
      'commands/ban.js': () => `const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban').setDescription('Bannit un membre du serveur.')
    .addUserOption(o => o.setName('utilisateur').setDescription('Membre à bannir').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))
    .addIntegerOption(o => o.setName('jours').setDescription('Jours de messages à supprimer (0-7)').setMinValue(0).setMaxValue(7).setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  async execute(interaction) {
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison') || 'Aucune raison';
    const days = interaction.options.getInteger('jours') ?? 0;
    if (target.id === interaction.user.id) return interaction.reply({ content: '❌ Action impossible sur vous-même.', flags: MessageFlags.Ephemeral });
    if (target.bot) return interaction.reply({ content: '❌ Impossible de bannir un bot via cette commande.', flags: MessageFlags.Ephemeral });

    try {
      await interaction.guild.members.ban(target, { reason, deleteMessageSeconds: days * 86400 });
      await interaction.reply({ content: \`✅ **\${target.tag}** banni — \${reason}\`, flags: MessageFlags.Ephemeral });
      const logCh = interaction.guild.channels.cache.get(process.env.MOD_LOG_CHANNEL_ID);
      if (logCh) await logCh.send({ embeds: [new EmbedBuilder().setTitle('⛔ Ban')
        .addFields({ name:'Membre', value:\`\${target.tag} (\${target.id})\`}, { name:'Modérateur', value:interaction.user.tag }, { name:'Raison', value:reason })
        .setColor(0xdc2626).setTimestamp()]}).catch(()=>{});
    } catch (err) {
      const msg = err.code === 50013 ? '❌ Permissions insuffisantes.' : '❌ Erreur : ' + err.message;
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
  }
};
`,
      'commands/clear.js': () => `const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear').setDescription('Supprime les derniers messages d\\'un salon.')
    .addIntegerOption(o => o.setName('nombre').setDescription('Nombre (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  async execute(interaction) {
    const amount = interaction.options.getInteger('nombre', true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const purged = await interaction.channel.bulkDelete(amount, true);
      await interaction.editReply({ content: \`✅ \${purged.size} message(s) supprimé(s).\` });
    } catch (err) {
      await interaction.editReply({ content: '❌ Erreur : ' + err.message });
    }
  }
};
`,
      'deploy-commands.js': () => `'use strict';
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('node:fs'); const path = require('node:path');

const commands = [];
const cmdPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(cmdPath).filter(f => f.endsWith('.js'))) {
  const cmd = require(path.join(cmdPath, file));
  if ('data' in cmd) commands.push(cmd.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
(async () => {
  try {
    if (!process.env.CLIENT_ID) throw new Error('CLIENT_ID manquant');
    if (process.env.GUILD_ID) {
      const d = await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
      console.log(\`✅ \${d.length} commande(s) déployée(s) sur le serveur\`);
    } else {
      const d = await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log(\`✅ \${d.length} commande(s) déployée(s) globalement\`);
    }
  } catch (e) { console.error(e); process.exit(1); }
})();
`,
      '.env.example': `TOKEN=
CLIENT_ID=
GUILD_ID=
MOD_LOG_CHANNEL_ID=
`,
      'README.md': () => `# Bot Discord — Modération

Commandes slash pour la modération d'un serveur Discord.

## Commandes incluses

| Commande | Description | Permission requise |
|----------|-------------|--------------------|
| /warn   | Avertir un membre (compteur persistant) | Modérer les membres |
| /mute   | Timeout d'un membre (1 min - 28 jours) | Modérer les membres |
| /kick   | Expulser un membre | Expulser des membres |
| /ban    | Bannir un membre | Bannir des membres |
| /clear  | Purge 1-100 messages | Gérer les messages |

## Configuration

1. Activez l'intent **Server Members** dans le portail développeur.
2. Placez le rôle du bot **au-dessus** des rôles qu'il doit modérer.
3. Créez un salon pour les logs de modération et récupérez son ID.
4. \`cp .env.example .env\` et remplissez les valeurs.
5. \`node deploy-commands.js\` puis \`npm start\`.

Géré par [Nexus Bot Manager](https://github.com/Julien48003/nexus-bot-manager).
`
    }
  },

  // ════════════════════════════════════════════════════════════════
  // Discord.js — Reaction Roles (NEW)
  // ════════════════════════════════════════════════════════════════
  {
    id: 'discordjs-roles',
    name: 'Discord.js — Rôles & Auto-rôles',
    description: 'Système de rôles par réaction et attribution automatique au join. Gestion propre des rôles inexistants.',
    longDescription: 'Le bot affiche un message avec des emojis ; les membres cliquent pour recevoir/retirer des rôles. Attribution automatique d\'un rôle par défaut à l\'arrivée.',
    icon: 'ti-tag',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'débutant',
    packages: ['discord.js', 'dotenv'],
    features: [
      'Auto-rôle à l\'arrivée',
      'Rôles par réaction (boutons)',
      'Embed de présentation des rôles',
      'Toggle add/remove sur clic',
      'Vérification d\'existence des rôles'
    ],
    intents: ['Guilds', 'GuildMembers', 'GuildMessageReactions'],
    envVars: [
      { key: 'TOKEN',          label: 'Token Discord',       required: true,  secret: true },
      { key: 'ROLES_CHANNEL_ID',label: 'Salon du panneau',   required: true,  secret: false },
      { key: 'AUTO_ROLE_ID',   label: 'Rôle automatique',   required: false, secret: false }
    ],
    files: {
      'index.js': () => `'use strict';
require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildMessages] });

const ROLES = [
  { emoji: '🎮', label: 'Gamer',      id: null },
  { emoji: '🎵', label: 'Musique',    id: null },
  { emoji: '📚', label: 'Lecture',    id: null },
  { emoji: '🎨', label: 'Art',        id: null }
];
// 👉 Renseignez les ID réels des rôles dans le tableau ci-dessus.

client.once(Events.ClientReady, async (c) => {
  console.log(\`[\${new Date().toISOString()}] ✅ \${c.user.tag} — Rôles actifs\`);
  if (!process.env.ROLES_CHANNEL_ID) return;
  const channel = c.channels.cache.get(process.env.ROLES_CHANNEL_ID);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle('🏷️ Choisissez vos rôles')
    .setDescription('Cliquez sur les boutons ci-dessous pour recevoir ou retirer les rôles.')
    .addFields(ROLES.filter(r => r.id).map(r => ({ name: \`\${r.emoji} \${r.label}\`, value: \`<@&\${r.id}>\`, inline: true })))
    .setColor(0x2563eb).setTimestamp();

  const rows = [];
  for (let i = 0; i < ROLES.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const r of ROLES.slice(i, i + 5).filter(x => x.id)) {
      row.addComponents(new ButtonBuilder().setCustomId(\`role_toggle_\${r.id}\`).setLabel(r.label).setEmoji(r.emoji).setStyle(ButtonStyle.Secondary));
    }
    if (row.components.length) rows.push(row);
  }
  if (rows.length) await channel.send({ embeds: [embed], components: rows });
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (!process.env.AUTO_ROLE_ID) return;
  const role = member.guild.roles.cache.get(process.env.AUTO_ROLE_ID);
  if (role) await member.roles.add(role).catch(err => console.error('[auto-role]', err.message));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith('role_toggle_')) return;
  const roleId = interaction.customId.replace('role_toggle_', '');
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) return interaction.reply({ content: '❌ Rôle introuvable. Contactez un administrateur.', flags: MessageFlags.Ephemeral });

  try {
    if (interaction.member.roles.cache.has(roleId)) {
      await interaction.member.roles.remove(roleId);
      await interaction.reply({ content: \`✅ Rôle **\${role.name}** retiré.\`, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.member.roles.add(roleId);
      await interaction.reply({ content: \`✅ Rôle **\${role.name}** ajouté.\`, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    const msg = err.code === 50013 ? '❌ Permissions insuffisantes. Le rôle du bot doit être au-dessus.' : '❌ Erreur : ' + err.message;
    await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }
});

process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
if (!process.env.TOKEN) { console.error('[FATAL] TOKEN manquant'); process.exit(1); }
client.login(process.env.TOKEN);
`,
      '.env.example': `TOKEN=
ROLES_CHANNEL_ID=
AUTO_ROLE_ID=
`,
      'README.md': () => `# Bot Discord — Rôles & Auto-rôles

- **Auto-rôle** : tout nouveau membre reçoit automatiquement un rôle (par ex. *Membre*).
- **Rôles par boutons** : un message avec des boutons permet d'ajouter/retirer des rôles librement.

## Configuration

1. Créez un salon dédié (par ex. \`#rôles\`).
2. Dans \`index.js\`, remplacez les \`id: null\` du tableau \`ROLES\` par les ID réels des rôles Discord.
3. Activez l'intent **Server Members**.
4. Le rôle du bot doit être **au-dessus** des rôles qu'il gère.

## Variables

| Variable | Description |
|----------|-------------|
| \`TOKEN\`            | Token du bot |
| \`ROLES_CHANNEL_ID\` | Salon du panneau |
| \`AUTO_ROLE_ID\`     | Rôle donné à chaque nouveau membre |

Géré par [Nexus Bot Manager](https://github.com/Julien48003/nexus-bot-manager).
`
    }
  },

  // ════════════════════════════════════════════════════════════════
  // Discord.js — Levels (kept for backward compatibility, refined)
  // ════════════════════════════════════════════════════════════════
  {
    id: 'discordjs-levels',
    name: 'Discord.js — Système de niveaux',
    description: 'Système XP/niveaux avec stockage JSON, commande /rank et annonce de level-up.',
    longDescription: 'Système de niveaux autonome : XP aléatoire par message, calcul polynomial de la progression, annonce configurable dans un salon dédié.',
    icon: 'ti-star',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'intermédiaire',
    packages: ['discord.js', 'dotenv'],
    features: [
      'XP aléatoire par message',
      'Calcul de niveau polynomial',
      'Commande /rank',
      'Annonce de level-up configurable',
      'Stockage JSON persistant'
    ],
    intents: ['Guilds', 'GuildMessages', 'MessageContent'],
    envVars: [
      { key: 'TOKEN',              label: 'Token Discord',      required: true,  secret: true },
      { key: 'CLIENT_ID',          label: 'Application ID',     required: true,  secret: false },
      { key: 'GUILD_ID',           label: 'ID du serveur',      required: false, secret: false },
      { key: 'LEVEL_UP_CHANNEL_ID',label: 'Salon level-up',     required: false, secret: false, hint: 'Vide = annonce dans le salon du message' }
    ],
    files: {
      'index.js': () => `'use strict';
require('dotenv').config();
const { Client, GatewayIntentBits, Events, Collection, EmbedBuilder } = require('discord.js');
const fs   = require('node:fs');
const path = require('node:path');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
client.commands = new Collection();

const cmdPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(cmdPath).filter(f => f.endsWith('.js'))) {
  const cmd = require(path.join(cmdPath, file));
  if ('data' in cmd && 'execute' in cmd) client.commands.set(cmd.data.name, cmd);
}

const evtPath = path.join(__dirname, 'events');
for (const file of fs.readdirSync(evtPath).filter(f => f.endsWith('.js'))) {
  const evt = require(path.join(evtPath, file));
  if (evt.once) client.once(evt.name, (...a) => evt.execute(...a, client));
  else          client.on(evt.name,    (...a) => evt.execute(...a, client));
}

const dbPath = path.join(__dirname, 'data', 'levels.json');
const utilsPath = path.join(__dirname, 'utils');
require(utilsPath);

process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
if (!process.env.TOKEN) { console.error('[FATAL] TOKEN manquant'); process.exit(1); }
client.login(process.env.TOKEN);
`,
      'utils/index.js': () => `// Helpers partagés (chargé depuis index.js)
const fs   = require('node:fs');
const path = require('node:path');
const DB_PATH = path.join(__dirname, '..', 'data', 'levels.json');

function loadDB()   { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return {}; } }
function saveDB(db) { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function xpForLevel(level) { return Math.floor(100 * Math.pow(level, 1.5)); }

module.exports = { loadDB, saveDB, xpForLevel };
`,
      'events/messageCreate.js': () => `const { Events } = require('discord.js');
const { loadDB, saveDB, xpForLevel } = require('../utils');

const COOLDOWN = 60_000; // 1 message / minute
const lastGain = new Map();

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (message.author.bot || !message.guild) return;
    const now = Date.now();
    const last = lastGain.get(message.author.id) || 0;
    if (now - last < COOLDOWN) return;
    lastGain.set(message.author.id, now);

    const db = loadDB();
    const key = \`\${message.guild.id}-\${message.author.id}\`;
    if (!db[key]) db[key] = { xp: 0, level: 0, tag: message.author.tag };
    db[key].xp += Math.floor(Math.random() * 10) + 5;
    db[key].tag = message.author.tag;
    const needed = xpForLevel(db[key].level + 1);
    if (db[key].xp >= needed) {
      db[key].level++;
      db[key].xp -= needed;
      const targetCh = process.env.LEVEL_UP_CHANNEL_ID
        ? message.guild.channels.cache.get(process.env.LEVEL_UP_CHANNEL_ID)
        : message.channel;
      if (targetCh) {
        const { EmbedBuilder } = require('discord.js');
        await targetCh.send({ embeds: [new EmbedBuilder()
          .setTitle('🎉 Level Up !')
          .setDescription(\`\${message.author} passe au niveau **\${db[key].level}** !\`)
          .setColor(0x2563eb).setTimestamp()] }).catch(()=>{});
    }
    saveDB(db);
  }
};
`,
      'commands/rank.js': () => `const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { loadDB, xpForLevel } = require('../utils');

module.exports = {
  data: new SlashCommandBuilder().setName('rank').setDescription('Affiche votre niveau.')
    .addUserOption(o => o.setName('utilisateur').setDescription('Membre ciblé').setRequired(false)),
  async execute(interaction) {
    const user = interaction.options.getUser('utilisateur') || interaction.user;
    const db = loadDB();
    const data = db[\`\${interaction.guild.id}-\${user.id}\`] || { xp: 0, level: 0 };
    const embed = new EmbedBuilder()
      .setTitle(\`Rang de \${user.username}\`)
      .addFields(
        { name: 'Niveau', value: String(data.level), inline: true },
        { name: 'XP',     value: \`\${data.xp} / \${xpForLevel(data.level + 1)}\`, inline: true }
      ).setColor(0x2563eb);
    await interaction.reply({ embeds: [embed] });
  }
};
`,
      'deploy-commands.js': () => `'use strict';
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('node:fs'); const path = require('node:path');
const commands = [];
for (const file of fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js'))) {
  const cmd = require(path.join(__dirname, 'commands', file));
  if ('data' in cmd) commands.push(cmd.data.toJSON());
}
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
(async () => {
  if (!process.env.CLIENT_ID) throw new Error('CLIENT_ID manquant');
  if (process.env.GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  }
  console.log(\`✅ \${commands.length} commande(s) déployée(s)\`);
})();
`,
      '.env.example': `TOKEN=
CLIENT_ID=
GUILD_ID=
LEVEL_UP_CHANNEL_ID=
`,
      'README.md': () => `# Bot Discord — Système de niveaux

XP aléatoire par message, calcul de niveau, commande \`/rank\`.

## Commandes

- \`/rank [utilisateur]\` : affiche le niveau et l'XP.

## Configuration

1. Activez l'intent **Message Content**.
2. \`cp .env.example .env\` puis remplissez les valeurs.
3. \`node deploy-commands.js\` puis \`npm start\`.

Géré par [Nexus Bot Manager](https://github.com/Julien48003/nexus-bot-manager).
`
    }
  },

  // ════════════════════════════════════════════════════════════════
  // Discord.js — Auto-mod (kept, refined)
  // ════════════════════════════════════════════════════════════════
  {
    id: 'discordjs-automod',
    name: 'Discord.js — Auto-modération',
    description: 'Filtrage mots interdits, anti-spam et anti-lien avec logs et gestion fine des exceptions.',
    longDescription: 'Filtre configurable : mots interdits, anti-spam (seuil + fenêtre), anti-lien avec allowlist. Toutes les actions sont loggées dans un salon dédié.',
    icon: 'ti-shield-check',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'intermédiaire',
    packages: ['discord.js', 'dotenv'],
    features: [
      'Liste de mots interdits personnalisable',
      'Anti-spam avec fenêtre glissante',
      'Anti-lien avec allowlist',
      'Exempt staff configurable',
      'Logs embed détaillés'
    ],
    intents: ['Guilds', 'GuildMessages', 'GuildMembers', 'MessageContent'],
    envVars: [
      { key: 'TOKEN',        label: 'Token Discord', required: true,  secret: true },
      { key: 'LOG_CHANNEL_ID', label: 'Salon de logs', required: false, secret: false },
      { key: 'ALLOWED_DOMAINS', label: 'Domaines autorisés (séparés par virgules)', required: false, secret: false, hint: 'Ex: discord.com,github.com' }
    ],
    files: {
      'index.js': () => `'use strict';
require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]
});

const BAD_WORDS = (process.env.BAD_WORDS || 'spam,insulte').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ALLOWED  = new Set((process.env.ALLOWED_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const SPAM_WINDOW_MS  = 5_000;
const SPAM_THRESHOLD  = 5;
const spamMap = new Map();

async function log(guild, embed) {
  if (!process.env.LOG_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
  if (ch) await ch.send({ embeds: [embed] }).catch(()=>{});
}

client.once(Events.ClientReady, (c) => console.log(\`[\${new Date().toISOString()}] ✅ \${c.user.tag} — Auto-mod actif\`));

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const content = message.content.toLowerCase();

  // Mots interdits
  if (BAD_WORDS.some(w => content.includes(w))) {
    await message.delete().catch(()=>{});
    const m = await message.channel.send(\`⚠️ \${message.author}, votre message ne respecte pas les règles.\`).catch(()=>null);
    if (m) setTimeout(() => m.delete().catch(()=>{}), 5000);
    await log(message.guild, new EmbedBuilder()
      .setTitle('🚫 Mot interdit').setDescription(\`\${message.author.tag} : \${message.content.slice(0,500)}\`)
      .setColor(0xdc2626).setTimestamp());
    return;
  }

  // Anti-lien
  const linkMatch = message.content.match(/(https?:\\/\\/[^\\s]+)/i);
  if (linkMatch) {
    try {
      const u = new URL(linkMatch[1]);
      if (!ALLOWED.has(u.hostname.toLowerCase())) {
        await message.delete().catch(()=>{});
        const m = await message.channel.send(\`⚠️ \${message.author}, les liens ne sont pas autorisés ici.\`).catch(()=>null);
        if (m) setTimeout(() => m.delete().catch(()=>{}), 5000);
        await log(message.guild, new EmbedBuilder()
          .setTitle('🔗 Lien bloqué').setDescription(\`\${message.author.tag} : \${u.hostname}\`)
          .setColor(0xd97706).setTimestamp());
        return;
      }
    } catch { /* URL invalide */ }
  }

  // Anti-spam
  const now = Date.now();
  const hist = (spamMap.get(message.author.id) || []).filter(t => now - t < SPAM_WINDOW_MS);
  hist.push(now);
  spamMap.set(message.author.id, hist);
  if (hist.length >= SPAM_THRESHOLD) {
    spamMap.set(message.author.id, []);
    await message.delete().catch(()=>{});
    await message.member.timeout(60_000, 'Anti-spam').catch(()=>{});
    await log(message.guild, new EmbedBuilder()
      .setTitle('⚠️ Spam').setDescription(\`\${message.author.tag} muté 60s.\`)
      .setColor(0xdc2626).setTimestamp());
  }
});

process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
if (!process.env.TOKEN) { console.error('[FATAL] TOKEN manquant'); process.exit(1); }
client.login(process.env.TOKEN);
`,
      '.env.example': `TOKEN=
LOG_CHANNEL_ID=
ALLOWED_DOMAINS=discord.com,github.com
BAD_WORDS=spam,insulte
`,
      'README.md': () => `# Bot Discord — Auto-modération

- Filtrage de **mots interdits** (variable \`BAD_WORDS\`)
- **Anti-spam** : 5 messages en 5 secondes → mute 60s
- **Anti-lien** avec allowlist (\`ALLOWED_DOMAINS\`)
- Logs embed dans \`#mod-logs\`

Géré par [Nexus Bot Manager](https://github.com/Julien48003/nexus-bot-manager).
`
    }
  }
];

// ════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════

function getAllTemplates() {
  return TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    longDescription: t.longDescription,
    icon: t.icon,
    category: t.category,
    runtime: t.runtime,
    version: t.version,
    difficulty: t.difficulty,
    packages: t.packages,
    features: t.features || [],
    intents: t.intents || [],
    envVars: t.envVars
  }));
}

function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}

function getCategories() {
  const cats = [...new Set(TEMPLATES.map(t => t.category))];
  return cats.map(c => ({
    id: c,
    label: c === 'discordjs' ? 'Discord.js' : c === 'discordpy' ? 'Discord.py' : c,
    count: TEMPLATES.filter(t => t.category === c).length
  }));
}

/**
 * Per-language string table for the user-facing parts of templates.
 * We translate:
 *   - Discord command descriptions (short labels)
 *   - Discord embed titles / field names
 *   - Bot welcome / goodbye messages
 *   - Log messages printed by the bot
 * We NEVER translate:
 *   - file names
 *   - .env keys
 *   - npm package names
 *   - Discord.js option names (those are technical identifiers)
 *   - JavaScript identifiers
 */
const TEMPLATE_STRINGS = {
  en: {
    cmd_ping_name: 'ping',
    cmd_ping_desc: 'Shows the bot and Discord API latency.',
    cmd_help_desc: 'Lists all available commands.',
    ready_msg: (tag) => `✅ ${tag} is online.`,
    welcome: (guild) => `Welcome to **${guild}**!`,
    rules_title: '📜 Server rules',
    rules_desc: 'Please read the rules before posting.',
    moderation_action: 'Action performed by a moderator.',
    ticket_created: '🎫 Ticket created — a staff member will reply shortly.',
    ticket_closed: '🔒 Ticket closed.',
    levels_up: (user, lvl) => `🎉 ${user} just reached level **${lvl}**!`,
    levels_xp: (cur, need) => `XP: ${cur} / ${need}`,
    automod_warn: '⚠️ Your message was flagged by the automod filter.'
  },
  fr: {
    cmd_ping_name: 'ping',
    cmd_ping_desc: 'Affiche la latence du bot et de l\'API Discord.',
    cmd_help_desc: 'Liste toutes les commandes disponibles.',
    ready_msg: (tag) => `✅ ${tag} est en ligne.`,
    welcome: (guild) => `Bienvenue sur **${guild}** !`,
    rules_title: '📜 Règles du serveur',
    rules_desc: 'Merci de lire les règles avant d\'écrire.',
    moderation_action: 'Action effectuée par un modérateur.',
    ticket_created: '🎫 Ticket créé — un membre du staff vous répondra bientôt.',
    ticket_closed: '🔒 Ticket fermé.',
    levels_up: (user, lvl) => `🎉 ${user} passe au niveau **${lvl}** !`,
    levels_xp: (cur, need) => `XP : ${cur} / ${need}`,
    automod_warn: '⚠️ Votre message a été signalé par l\'automod.'
  },
  de: {
    cmd_ping_name: 'ping',
    cmd_ping_desc: 'Zeigt die Latenz des Bots und der Discord-API.',
    cmd_help_desc: 'Listet alle verfügbaren Befehle auf.',
    ready_msg: (tag) => `✅ ${tag} ist online.`,
    welcome: (guild) => `Willkommen auf **${guild}**!`,
    rules_title: '📜 Serverregeln',
    rules_desc: 'Bitte lies die Regeln, bevor du schreibst.',
    moderation_action: 'Aktion eines Moderators.',
    ticket_created: '🎫 Ticket erstellt — ein Teammitglied wird sich bald melden.',
    ticket_closed: '🔒 Ticket geschlossen.',
    levels_up: (user, lvl) => `🎉 ${user} hat Stufe **${lvl}** erreicht!`,
    levels_xp: (cur, need) => `XP: ${cur} / ${need}`,
    automod_warn: '⚠️ Deine Nachricht wurde vom Automod-Filter markiert.'
  }
};

function stringsFor(language) {
  const lang = ['en', 'fr', 'de'].includes(language) ? language : 'en';
  return TEMPLATE_STRINGS[lang] || TEMPLATE_STRINGS.en;
}

/**
 * Generate all files for a given template.
 * @param {string} templateId
 * @param {object} [opts]
 * @param {string} [opts.language]      'en' | 'fr' | 'de' — defaults to 'en'
 * @returns {Object} { filename: content }
 */
function generateFiles(templateId, opts = {}) {
  const tpl = getTemplate(templateId);
  if (!tpl) throw new Error(`Template "${templateId}" introuvable`);
  const lang = ['en', 'fr', 'de'].includes(opts.language) ? opts.language : 'en';
  const ctx = { language: lang, strings: stringsFor(lang) };
  const result = {};
  for (const [fname, generator] of Object.entries(tpl.files)) {
    result[fname] = typeof generator === 'function' ? generator(ctx) : generator;
  }
  return result;
}

module.exports = {
  getAllTemplates,
  getTemplate,
  getCategories,
  generateFiles,
  stringsFor
};