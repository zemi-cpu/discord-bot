require('dotenv').config();
const express = require('express');
const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionsBitField
} = require('discord.js');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS.split(','); // Both users can use commands
const GUILD_ID = process.env.GUILD_ID; // Optional for faster slash command updates
const API_PORT = process.env.API_PORT;
const KEYS_FILE = './keys.json';
const SERVER_INFO_FILE = './server_info.txt';
const CONFIG_FILE = './config.json';

const app = express();
app.use(express.json());

// Load or create keys
let keys = {};
if (fs.existsSync(KEYS_FILE)) {
    keys = JSON.parse(fs.readFileSync(KEYS_FILE));
}

// Load or create config for welcome and tickets
let config = {
    welcomeChannelId: null,
    ticketCounter: 1
};
if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE));
}

function saveKeys() {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function generateKey(type) {
    const id = uuidv4().split('-')[0].toUpperCase();
    return `Firebase-${type}-${id}`;
}

// API endpoint for validation
app.post('/validate', (req, res) => {
    const { key, hwid } = req.body;
    if (!key || !hwid) return res.status(400).json({ success: false, message: 'Missing key or HWID.' });

    const data = keys[key];
    if (!data) return res.status(404).json({ success: false, message: 'Invalid key.' });

    const now = Date.now();
    if (data.expiry !== 'lifetime' && now > data.expiry) {
        return res.status(403).json({ success: false, message: 'Key expired.' });
    }

    if (!data.hwid) {
        data.hwid = hwid;
        saveKeys();
        return res.json({ success: true, message: 'HWID bound.' });
    }

    if (data.hwid !== hwid) {
        return res.status(403).json({ success: false, message: 'HWID mismatch.' });
    }

    return res.json({ success: true, message: 'Key valid.' });
});

// Fetch and save public IP
async function savePublicIP() {
    try {
        const res = await axios.get('https://api.ipify.org?format=json');
        const ip = res.data.ip;
        const url = `http://${ip}:${API_PORT}`;
        fs.writeFileSync(SERVER_INFO_FILE, url);
        console.log(`✅ Public IP detected and saved: ${url}`);
    } catch (err) {
        console.error('❌ Failed to fetch public IP:', err.message);
    }
}

// Start API server
app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`✅ API running on 0.0.0.0:${API_PORT}`);
    savePublicIP();
});

// Discord bot setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', () => {
    console.log(`🤖 Bot ready as ${client.user.tag}`);
});

// Listener for slash commands and button interactions
client.on('interactionCreate', async interaction => {
    // Slash Command Handler
    if (interaction.isChatInputCommand()) {
        if (!ADMIN_USER_IDS.includes(interaction.user.id)) {
            return interaction.reply({ content: '❌ You are not authorized.', ephemeral: true });
        }

        const { commandName } = interaction;

        if (commandName === 'genkey') {
            const type = interaction.options.getString('type');
            let duration;
            if (type === 'day') duration = 24 * 60 * 60 * 1000;
            else if (type === 'week') duration = 7 * 24 * 60 * 60 * 1000;
            else if (type === 'month') duration = 30 * 24 * 60 * 60 * 1000;
            else if (type === 'year') duration = 365 * 24 * 60 * 60 * 1000;
            else if (type === 'lifetime') duration = 'lifetime';
            else return interaction.reply({ content: '❌ Invalid type.', ephemeral: true });

            const key = generateKey(type);
            keys[key] = {
                hwid: null,
                expiry: duration === 'lifetime' ? 'lifetime' : Date.now() + duration
            };
            saveKeys();
            await interaction.reply({ content: `✅ Key generated: \`${key}\``, ephemeral: true });
        } else if (commandName === 'checkkey') {
            const key = interaction.options.getString('key');
            const data = keys[key];
            if (!data) return interaction.reply({ content: '❌ Invalid key.', ephemeral: true });
            const status = data.hwid ? `HWID Locked: \`${data.hwid}\`` : 'Not bound';
            const expiry = data.expiry === 'lifetime' ? 'Never' : new Date(data.expiry).toLocaleString();
            await interaction.reply({ content: `🔑 Key: \`${key}\`\nStatus: ${status}\nExpires: ${expiry}`, ephemeral: true });
        } else if (commandName === 'revokekey') {
            const key = interaction.options.getString('key');
            if (!keys[key]) return interaction.reply({ content: '❌ Invalid key.', ephemeral: true });
            delete keys[key];
            saveKeys();
            await interaction.reply({ content: `❌ Key revoked: \`${key}\``, ephemeral: true });
        }
    }
    // Button Interaction Handler
    else if (interaction.isButton()) {
        if (interaction.customId === 'create_ticket') {
            const ticketChannelName = `ticket-${config.ticketCounter}`;
            
            // Check if a ticket channel for this user already exists
            const existingChannel = interaction.guild.channels.cache.find(c => c.name === `ticket-${interaction.user.id.slice(-4)}`);
            if(existingChannel) {
                return interaction.reply({ content: `You already have an open ticket: ${existingChannel}`, ephemeral: true });
            }

            const channel = await interaction.guild.channels.create({
                name: ticketChannelName,
                type: ChannelType.GuildText,
                permissionOverwrites: [{
                        id: interaction.guild.id, // @everyone
                        deny: [PermissionsBitField.Flags.ViewChannel],
                    },
                    {
                        id: interaction.user.id,
                        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
                    },
                    // You can add a specific support role ID here if you have one
                ],
            });

            // Add all admins to the ticket
            ADMIN_USER_IDS.forEach(adminId => {
                channel.permissionOverwrites.edit(adminId, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true
                });
            });


            const ticketEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`Ticket #${config.ticketCounter}`)
                .setDescription(`Welcome, ${interaction.user}! An admin will be with you shortly.\n\nPlease describe the product you wish to purchase or the issue you are facing.`)
                .setFooter({ text: `Ticket created by ${interaction.user.tag}` })
                .setTimestamp();

            const closeButton = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('Close Ticket')
                .setStyle(ButtonStyle.Danger)
            );

            await channel.send({ content: `${interaction.user} <@${ADMIN_USER_IDS[0]}>`, embeds: [ticketEmbed], components: [closeButton] });
            await interaction.reply({ content: `✅ Your ticket has been created: ${channel}`, ephemeral: true });

            config.ticketCounter++;
            saveConfig();

        } else if (interaction.customId === 'close_ticket') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
                 return interaction.reply({ content: '❌ You do not have permission to close this ticket.', ephemeral: true });
            }
            await interaction.reply(`Closing this ticket in 5 seconds...`);
            setTimeout(() => interaction.channel.delete(), 5000);
        }
    }
});

// Listener for message-based commands (!ticket, !setwelcome)
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    if (!ADMIN_USER_IDS.includes(message.author.id)) return;

    if (message.content.toLowerCase() === '!ticket') {
        const ticketPanelEmbed = new EmbedBuilder()
            .setColor('#2ECC71')
            .setTitle('Create a Ticket')
            .setDescription('Click the button below to open a private ticket for purchasing or support.');

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
            .setCustomId('create_ticket')
            .setLabel('Create Ticket')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🎟️')
        );

        await message.channel.send({ embeds: [ticketPanelEmbed], components: [row] });
        await message.delete(); // Clean up the command message
    }

    if (message.content.toLowerCase() === '!setwelcome') {
        config.welcomeChannelId = message.channel.id;
        saveConfig();

        const confirmationEmbed = new EmbedBuilder()
            .setColor('#3498DB')
            .setDescription(`✅ Welcome messages will now be sent to this channel (${message.channel}).`);
        await message.channel.send({ embeds: [confirmationEmbed] });
    }
});


// Listener for new members joining
client.on('guildMemberAdd', async member => {
    if (!config.welcomeChannelId) return;

    const channel = member.guild.channels.cache.get(config.welcomeChannelId);
    if (!channel) {
        // Channel might have been deleted, so we reset it.
        config.welcomeChannelId = null;
        saveConfig();
        return;
    }

    const welcomeEmbed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle(`Welcome to ${member.guild.name}!`)
        .setDescription(`Hello ${member}, we're happy to have you here!`)
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp();

    channel.send({ embeds: [welcomeEmbed] });
});


// Register slash commands
const commands = [
    new SlashCommandBuilder()
    .setName('genkey')
    .setDescription('Generate a new key')
    .addStringOption(option =>
        option.setName('type')
        .setDescription('Key duration: day, week, month, year, lifetime')
        .setRequired(true)),
    new SlashCommandBuilder()
    .setName('checkkey')
    .setDescription('Check key status')
    .addStringOption(option =>
        option.setName('key')
        .setDescription('Key to check')
        .setRequired(true)),
    new SlashCommandBuilder()
    .setName('revokekey')
    .setDescription('Revoke a key')
    .addStringOption(option =>
        option.setName('key')
        .setDescription('Key to revoke')
        .setRequired(true))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
    try {
        console.log('⚙️ Registering slash commands...');
        if (GUILD_ID) {
            await rest.put(
                Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands }
            );
        } else {
            await rest.put(
                Routes.applicationCommands(CLIENT_ID), { body: commands }
            );
        }
        console.log('✅ Slash commands registered!');
    } catch (error) {
        console.error(error);
    }
})();

client.login(DISCORD_TOKEN);
