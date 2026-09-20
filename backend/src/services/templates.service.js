'use strict';
/**
 * Nexus Bot Manager — Built-in Templates
 * Each template has metadata + generated file content
 */

const TEMPLATES = [
  // ── Discord.js ───────────────────────────────────────────
  {
    id: 'discordjs-blank',
    name: 'Discord.js — Minimal',
    description: 'Bot minimal prêt à l\'emploi. Point de départ idéal pour construire votre bot.',
    icon: 'ti-code',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'débutant',
    packages: ['discord.js', 'dotenv'],
    envVars: [
      { key: 'TOKEN', label: 'Token Discord', required: true, secret: true, hint: 'Disponible sur discord.com/developers' }
    ],
    files: {
      'index.js': () => `require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(\`[\\${new Date().toISOString()}] ✅ Connecté : \\${client.user.tag}\`);
});

process.on('unhandledRejection', (error) => {
  console.error(\`[\\${new Date().toISOString()}] ❌ Erreur non gérée:\`, error);
});

client.login(process.env.TOKEN);
`
    }
  },

  {
    id: 'discordjs-slash',
    name: 'Discord.js — Slash Commands',
    description: 'Architecture complète avec chargement automatique des commandes slash et des événements.',
    icon: 'ti-terminal-2',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'intermédiaire',
    packages: ['discord.js', 'dotenv'],
    envVars: [
      { key: 'TOKEN',     label: 'Token Discord',    required: true,  secret: true },
      { key: 'CLIENT_ID', label: 'Application ID',   required: true,  secret: false, hint: 'ID de votre application Discord' },
      { key: 'GUILD_ID',  label: 'ID du serveur',    required: false, secret: false, hint: 'Laisser vide pour déploiement global' }
    ],
    files: {
      'index.js': () => `require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs   = require('fs');
const path = require('path');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Chargement des commandes
client.commands = new Collection();
const cmdPath  = path.join(__dirname, 'commands');
if (fs.existsSync(cmdPath)) {
  for (const file of fs.readdirSync(cmdPath).filter(f => f.endsWith('.js'))) {
    const cmd = require(path.join(cmdPath, file));
    if (cmd?.data?.name) client.commands.set(cmd.data.name, cmd);
  }
}

// Chargement des événements
const evtPath = path.join(__dirname, 'events');
if (fs.existsSync(evtPath)) {
  for (const file of fs.readdirSync(evtPath).filter(f => f.endsWith('.js'))) {
    const evt = require(path.join(evtPath, file));
    client[evt.once ? 'once' : 'on'](evt.name, (...args) => evt.execute(...args, client));
  }
}

process.on('unhandledRejection', err => console.error('[ERREUR]', err));
client.login(process.env.TOKEN);
`,
      'commands/ping.js': () => `const { SlashCommandBuilder } = require('discord.js');
module.exports = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Affiche la latence du bot'),
  async execute(interaction) {
    await interaction.reply(\`🏓 Pong ! Latence : \\${Date.now() - interaction.createdTimestamp}ms\`);
  }
};
`,
      'events/ready.js': () => `module.exports = {
  name: 'ready',
  once: true,
  execute(client) {
    console.log(\`[\\${new Date().toISOString()}] ✅ \\${client.user.tag} prêt — \\${client.commands.size} commandes\`);
  }
};
`,
      'events/interactionCreate.js': () => `module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client) {
    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      const msg = { content: 'Une erreur est survenue.', ephemeral: true };
      interaction.replied ? await interaction.followUp(msg) : await interaction.reply(msg);
    }
  }
};
`,
      'deploy-commands.js': () => `require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs   = require('fs');
const path = require('path');

const commands = [];
const cmdPath  = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(cmdPath).filter(f => f.endsWith('.js'))) {
  const cmd = require(path.join(cmdPath, file));
  if (cmd?.data) commands.push(cmd.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
(async () => {
  console.log('Déploiement des commandes...');
  if (process.env.GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('✅ Commandes déployées sur le serveur');
  } else {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Commandes déployées globalement');
  }
})();
`
    }
  },

  {
    id: 'discordjs-ticket',
    name: 'Discord.js — Système de Tickets',
    description: 'Système de tickets complet avec boutons, threads privés, ouverture et fermeture.',
    icon: 'ti-ticket',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'intermédiaire',
    packages: ['discord.js', 'dotenv'],
    envVars: [
      { key: 'TOKEN',            label: 'Token Discord',       required: true,  secret: true },
      { key: 'TICKET_CHANNEL_ID',label: 'Salon des tickets',   required: true,  secret: false },
      { key: 'STAFF_ROLE_ID',    label: 'Rôle Staff',         required: false, secret: false }
    ],
    files: {
      'index.js': () => `require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', async () => {
  console.log(\`[\\${new Date().toISOString()}] ✅ \\${client.user.tag} — Système de tickets actif\`);
  
  // Envoyer le panneau de tickets dans le salon configuré
  const channel = client.channels.cache.get(process.env.TICKET_CHANNEL_ID);
  if (channel) {
    const embed = new EmbedBuilder()
      .setTitle('🎫 Support')
      .setDescription('Cliquez sur le bouton ci-dessous pour ouvrir un ticket.')
      .setColor(0x2563eb);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_ticket').setLabel('Ouvrir un ticket').setStyle(ButtonStyle.Primary).setEmoji('🎫')
    );
    await channel.send({ embeds: [embed], components: [row] });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  
  if (interaction.customId === 'open_ticket') {
    const thread = await interaction.channel.threads.create({
      name: \`ticket-\\${interaction.user.username}-\\${Date.now().toString(36)}\`,
      type: ChannelType.PrivateThread,
      reason: \`Ticket ouvert par \\${interaction.user.tag}\`
    });
    await thread.members.add(interaction.user.id);
    
    const embed = new EmbedBuilder()
      .setTitle('Ticket ouvert')
      .setDescription(\`Bonjour \\${interaction.user}, un membre du staff vous répondra bientôt.\`)
      .setColor(0x2563eb).setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('close_ticket').setLabel('Fermer le ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );
    await thread.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: \`Ticket créé : \\${thread}\`, ephemeral: true });
  }
  
  if (interaction.customId === 'close_ticket') {
    await interaction.reply({ content: 'Fermeture du ticket...', ephemeral: true });
    await interaction.channel.setArchived(true);
  }
});

process.on('unhandledRejection', err => console.error('[ERREUR]', err));
client.login(process.env.TOKEN);
`
    }
  },

  {
    id: 'discordjs-moderation',
    name: 'Discord.js — Modération',
    description: 'Bot de modération avec commandes ban, kick, mute, clear et système de logs.',
    icon: 'ti-shield',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'intermédiaire',
    packages: ['discord.js', 'dotenv'],
    envVars: [
      { key: 'TOKEN',     label: 'Token Discord', required: true,  secret: true },
      { key: 'MOD_LOG_CHANNEL_ID', label: 'Salon de logs modération', required: false, secret: false }
    ],
    files: {
      'index.js': () => `require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]
});

const PREFIX = '!';

async function logAction(guild, action, target, mod, reason) {
  if (!process.env.MOD_LOG_CHANNEL_ID) return;
  const channel = guild.channels.cache.get(process.env.MOD_LOG_CHANNEL_ID);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setTitle(\`Modération — \\${action}\`)
    .addFields(
      { name: 'Utilisateur', value: \`\\${target.tag} (\\${target.id})\`, inline: true },
      { name: 'Modérateur',  value: \`\\${mod.tag}\`, inline: true },
      { name: 'Raison',      value: reason || 'Aucune raison fournie' }
    )
    .setColor(action === 'Ban' ? 0xdc2626 : action === 'Kick' ? 0xd97706 : 0x2563eb)
    .setTimestamp();
  await channel.send({ embeds: [embed] });
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  const args    = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const hasPerm = (perm) => message.member.permissions.has(perm);

  if (command === 'ban') {
    if (!hasPerm(PermissionFlagsBits.BanMembers)) return message.reply('❌ Permission insuffisante.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mentionnez un membre.');
    const reason = args.slice(1).join(' ') || 'Aucune raison';
    await target.ban({ reason });
    await logAction(message.guild, 'Ban', target.user, message.author, reason);
    await message.reply(\`✅ **\\${target.user.tag}** a été banni.\`);
  }

  if (command === 'kick') {
    if (!hasPerm(PermissionFlagsBits.KickMembers)) return message.reply('❌ Permission insuffisante.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Mentionnez un membre.');
    const reason = args.slice(1).join(' ') || 'Aucune raison';
    await target.kick(reason);
    await logAction(message.guild, 'Kick', target.user, message.author, reason);
    await message.reply(\`✅ **\\${target.user.tag}** a été expulsé.\`);
  }

  if (command === 'clear') {
    if (!hasPerm(PermissionFlagsBits.ManageMessages)) return message.reply('❌ Permission insuffisante.');
    const n = Math.min(parseInt(args[0]) || 10, 100);
    const deleted = await message.channel.bulkDelete(n + 1, true);
    const msg = await message.channel.send(\`✅ \\${deleted.size - 1} messages supprimés.\`);
    setTimeout(() => msg.delete().catch(() => {}), 3000);
  }
});

client.once('ready', () => console.log(\`[\\${new Date().toISOString()}] ✅ \\${client.user.tag} — Bot de modération actif\`));
process.on('unhandledRejection', err => console.error('[ERREUR]', err));
client.login(process.env.TOKEN);
`
    }
  },

  {
    id: 'discordjs-welcome',
    name: 'Discord.js — Bienvenue',
    description: 'Bot de bienvenue avec embed personnalisé, attribution automatique de rôle et message de départ.',
    icon: 'ti-door-enter',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'débutant',
    packages: ['discord.js', 'dotenv'],
    envVars: [
      { key: 'TOKEN',              label: 'Token Discord',     required: true,  secret: true },
      { key: 'WELCOME_CHANNEL_ID', label: 'Salon de bienvenue', required: true, secret: false },
      { key: 'LEAVE_CHANNEL_ID',   label: 'Salon de départ',   required: false, secret: false },
      { key: 'MEMBER_ROLE_ID',     label: 'Rôle à attribuer',  required: false, secret: false }
    ],
    files: {
      'index.js': () => `require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

client.on('guildMemberAdd', async (member) => {
  console.log(\`[\\${new Date().toISOString()}] Nouveau membre : \\${member.user.tag}\`);
  
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (channel) {
    const embed = new EmbedBuilder()
      .setTitle(\`👋 Bienvenue sur \\${member.guild.name} !\`)
      .setDescription(\`Bonjour \\${member}, nous sommes ravis de t'accueillir parmi nous !\\n\\nTu es le membre numéro **\\${member.guild.memberCount}** 🎉\`)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
      .setColor(0x2563eb)
      .setTimestamp();
    await channel.send({ content: \`\\${member}\`, embeds: [embed] });
  }
  
  if (process.env.MEMBER_ROLE_ID) {
    const role = member.guild.roles.cache.get(process.env.MEMBER_ROLE_ID);
    if (role) await member.roles.add(role).catch(console.error);
  }
});

client.on('guildMemberRemove', async (member) => {
  const channel = member.guild.channels.cache.get(process.env.LEAVE_CHANNEL_ID);
  if (channel) {
    await channel.send(\`👋 **\\${member.user.tag}** a quitté le serveur.\`);
  }
});

client.once('ready', () => console.log(\`[\\${new Date().toISOString()}] ✅ \\${client.user.tag} — Bot de bienvenue actif\`));
process.on('unhandledRejection', err => console.error('[ERREUR]', err));
client.login(process.env.TOKEN);
`
    }
  },

  {
    id: 'discordjs-levels',
    name: 'Discord.js — Système de niveaux',
    description: 'Système XP/niveaux avec stockage JSON, commandes rang et classement.',
    icon: 'ti-star',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'avancé',
    packages: ['discord.js', 'dotenv'],
    envVars: [
      { key: 'TOKEN',          label: 'Token Discord',          required: true,  secret: true },
      { key: 'LEVEL_UP_CHANNEL_ID', label: 'Salon level-up',   required: false, secret: false }
    ],
    files: {
      'index.js': () => `require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');

const client  = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const DB_PATH = path.join(__dirname, 'data', 'levels.json');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function loadDB()   { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return {}; } }
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

function getXpForLevel(level) { return 100 * Math.pow(level, 1.5); }

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const db  = loadDB();
  const key = \`\\${message.guild.id}-\\${message.author.id}\`;
  if (!db[key]) db[key] = { xp: 0, level: 0, username: message.author.tag };
  
  const xpGain = Math.floor(Math.random() * 10) + 5;
  db[key].xp  += xpGain;
  db[key].username = message.author.tag;
  
  const needed = getXpForLevel(db[key].level + 1);
  if (db[key].xp >= needed) {
    db[key].level++;
    const channel = process.env.LEVEL_UP_CHANNEL_ID ? message.guild.channels.cache.get(process.env.LEVEL_UP_CHANNEL_ID) : message.channel;
    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle('🎉 Level Up !')
        .setDescription(\`\\${message.author} est maintenant niveau **\\${db[key].level}** !\`)
        .setColor(0x2563eb).setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  }
  saveDB(db);
});

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith('!rank')) return;
  const db  = loadDB();
  const key = \`\\${message.guild.id}-\\${message.author.id}\`;
  const data = db[key] || { xp: 0, level: 0 };
  const embed = new EmbedBuilder()
    .setTitle(\`Rang de \\${message.author.username}\`)
    .addFields(
      { name: 'Niveau', value: String(data.level), inline: true },
      { name: 'XP', value: \`\\${data.xp} / \\${Math.floor(getXpForLevel(data.level + 1))}\`, inline: true }
    ).setColor(0x2563eb);
  await message.reply({ embeds: [embed] });
});

client.once('ready', () => console.log(\`[\\${new Date().toISOString()}] ✅ \\${client.user.tag} — Système de niveaux actif\`));
process.on('unhandledRejection', err => console.error('[ERREUR]', err));
client.login(process.env.TOKEN);
`
    }
  },

  {
    id: 'discordjs-automod',
    name: 'Discord.js — Auto-modération',
    description: 'Filtrage automatique des messages avec liste de mots interdits, anti-spam et anti-lien.',
    icon: 'ti-shield-check',
    category: 'discordjs',
    runtime: 'node',
    version: '14.x',
    difficulty: 'intermédiaire',
    packages: ['discord.js', 'dotenv'],
    envVars: [
      { key: 'TOKEN',        label: 'Token Discord',      required: true,  secret: true },
      { key: 'LOG_CHANNEL_ID', label: 'Salon de logs',   required: false, secret: false }
    ],
    files: {
      'index.js': () => `require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const client   = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const BADWORDS = ['spam', 'insulte']; // Personnalisez cette liste
const spamMap  = new Map(); // userId -> [timestamps]

async function logModAction(guild, embed) {
  if (!process.env.LOG_CHANNEL_ID) return;
  const channel = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
  if (channel) await channel.send({ embeds: [embed] });
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const content = message.content.toLowerCase();
  
  // Filtre mots interdits
  if (BADWORDS.some(w => content.includes(w))) {
    await message.delete().catch(() => {});
    await message.channel.send(\`\\${message.author}, ce message ne respecte pas les règles.\`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
    return;
  }

  // Anti-spam (5 messages en 5 secondes)
  const now    = Date.now();
  const history = spamMap.get(message.author.id) || [];
  history.push(now);
  const recent = history.filter(t => now - t < 5000);
  spamMap.set(message.author.id, recent);
  
  if (recent.length >= 5) {
    await message.delete().catch(() => {});
    await message.member.timeout(60000, 'Anti-spam').catch(() => {});
    const embed = new EmbedBuilder().setTitle('Anti-spam').setDescription(\`\\${message.author.tag} a été mute 60s pour spam.\`).setColor(0xdc2626);
    await logModAction(message.guild, embed);
    return;
  }
});

client.once('ready', () => console.log(\`[\\${new Date().toISOString()}] ✅ \\${client.user.tag} — Auto-mod actif\`));
process.on('unhandledRejection', err => console.error('[ERREUR]', err));
client.login(process.env.TOKEN);
`
    }
  }
];

function getAllTemplates() {
  return TEMPLATES.map(t => ({
    id: t.id, name: t.name, description: t.description,
    icon: t.icon, category: t.category, runtime: t.runtime,
    version: t.version, difficulty: t.difficulty,
    packages: t.packages, envVars: t.envVars
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
 * Generate all files for a given template.
 * @returns {Object} { filename: content }
 */
function generateFiles(templateId) {
  const tpl = getTemplate(templateId);
  if (!tpl) throw new Error(`Template "${templateId}" introuvable`);
  const result = {};
  for (const [fname, generator] of Object.entries(tpl.files)) {
    result[fname] = typeof generator === 'function' ? generator() : generator;
  }
  return result;
}

module.exports = { getAllTemplates, getTemplate, getCategories, generateFiles };
