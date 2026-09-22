<p align="center"> <img src="https://github.com/user-attachments/assets/92400bff-6aad-43c3-a8b8-f22537cc3cfd" alt="Nexus Bot Manager" width="350"> </p>

**A modern self-hosted control panel for Discord bots.**

Nexus Bot Manager lets you create, configure, deploy, run and monitor Node.js Discord bots from a single web interface.

<p align="center">

[![Website](https://img.shields.io/badge/Website-nexus.dj--julien.fr-111827?style=flat-square)](https://nexus.dj-julien.fr)
[![Latest Release](https://img.shields.io/github/v/release/Julien48003/nexus-bot-manager?style=flat-square)](https://github.com/Julien48003/nexus-bot-manager/releases)
[![GitHub Stars](https://img.shields.io/github/stars/Julien48003/nexus-bot-manager?style=flat-square)](https://github.com/Julien48003/nexus-bot-manager/stargazers)
[![Issues](https://img.shields.io/github/issues/Julien48003/nexus-bot-manager?style=flat-square)](https://github.com/Julien48003/nexus-bot-manager/issues)

</p>

---

## 🚀 Installation

Install Nexus with a single command:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Julien48003/nexus-bot-manager/main/scripts/install.sh)"
```

The official installer automatically installs and configures the required components.

After installation, Nexus is available through the web interface.

### 📖 Documentation

[![Documentation](https://img.shields.io/badge/Documentation-nexus.dj--julien.fr-111827?style=flat-square)](https://nexus.dj-julien.fr/docs.html)

### 📦 Releases

[![Releases](https://img.shields.io/badge/Releases-GitHub-111827?style=flat-square\&logo=github)](https://github.com/Julien48003/nexus-bot-manager/releases)

---

## ✨ Features

* 🤖 **Discord Bot Management** — Create, start, stop and restart bots
* 🧩 **Built-in Templates** — 9 ready-to-use Discord.js templates (minimal, slash commands, verification, welcome, tickets, moderation, roles, levels, auto-mod)
* 📝 **Web Code Editor** — Edit bot files directly from your browser (Monaco)
* 📁 **File Explorer** — Browse, create, rename, upload and delete files
* 📦 **npm Management** — Install and remove packages from the interface
* 📊 **Resource Monitoring** — Monitor CPU, RAM, disk and uptime
* 📜 **Live Logs** — View bot logs in real time
* 💾 **Import & Export** — Backup and restore bot projects (.zip)
* ⚡ **PM2 Integration** — Reliable Node.js process management
* 🎨 **Light / Dark / System Themes** — 13 accent colors and density options
* 🔄 **Built-in Update System** — Check GitHub for newer versions, one-click update with live progress and safe restart (Paramètres → Logiciel)
* 🔐 **Authentication** — JWT-based authentication and protected API routes
* 🛡️ **Security Controls** — Rate limiting, input validation, protected file operations, shell-safe command execution, update lockfile
* 🌐 **Self-Hosted** — Your bots and data remain on your own infrastructure
* 🆘 **Built-in Help Center** — Quick start, FAQ and direct links to the documentation

---

## 🖥️ Interface

Nexus provides a centralized web interface for managing your Discord bot infrastructure.

```text
┌──────────────────────────────────────────────────────┐
│                    Nexus Dashboard                   │
├───────────────┬──────────────────────────────────────┤
│               │                                      │
│   Dashboard   │          Bot Management              │
│               │                                      │
│   Bots        │   ● Online     CPU   RAM   Logs      │
│               │                                      │
│   Files       │   ● Online     CPU   RAM   Logs      │
│               │                                      │
│   Settings    │   ● Offline                          │
│               │                                      │
└───────────────┴──────────────────────────────────────┘
```

---

## 🏗️ Architecture

Nexus acts as a management layer for Node.js Discord bots.

```text
                         Web Browser
                              │
                              │ HTTPS / HTTP
                              ▼
                    ┌─────────────────────┐
                    │   Nexus Bot Manager │
                    │      Express.js     │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
          File System         PM2          Monitoring
                               │
                     ┌─────────┼─────────┐
                     ▼         ▼         ▼
                   Bot 1     Bot 2     Bot 3
```

Nexus uses **PM2** to manage Node.js bot processes.

> Nexus is a management platform, not a container runtime. Bots managed by Nexus are not automatically isolated from each other like containers or virtual machines.

---

## 💻 Requirements

| Requirement | Minimum         |
| ----------- | --------------- |
| OS          | Debian 11/12, Ubuntu 22.04/24.04 |
| Node.js     | 20 LTS          |
| RAM         | 512 MB          |
| Storage     | 1 GB            |
| Access      | Root            |

Nexus can be deployed on:

* Proxmox LXC
* VPS
* Dedicated servers
* Home servers
* Other supported Linux environments

---

## 🧩 Technology

| Component        | Technology        |
| ---------------- | ----------------- |
| Runtime          | Node.js           |
| Backend          | Express.js        |
| Real-time        | Socket.IO         |
| Process Manager  | PM2               |
| Authentication   | JWT               |
| Password Hashing | bcrypt            |
| File Uploads     | Multer            |
| Monitoring       | systeminformation |

---

## 📁 Bot Structure

Each bot is managed as an independent Node.js project.

```text
/opt/
├── bot-one/
│   ├── index.js
│   ├── package.json
│   ├── .env
│   └── node_modules/
│
└── bot-two/
    ├── index.js
    ├── package.json
    ├── .env
    └── node_modules/
```

---

## 🔒 Security

Nexus includes multiple application-level security mechanisms:

* JWT authentication
* Password hashing
* Login rate limiting
* API rate limiting
* Input validation
* Bot name validation
* Protected file paths
* Directory traversal protections
* Restricted file operations
* Security-related HTTP headers
* Automatically generated JWT secrets

For Internet-facing deployments, HTTPS and a properly configured reverse proxy are recommended.

> Security also depends on the configuration of the underlying operating system, network and reverse proxy.

---

## 🔄 Updates

### Two ways to update Nexus

**1. From the web interface (recommended)** — open **Paramètres → Logiciel**, click **Vérifier les mises à jour**, then **Mettre à jour**. Live progress, automatic restart, no manual work.

**2. From the server** —

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Julien48003/nexus-bot-manager/main/scripts/update.sh)"
```

Your `.env` file, the `data/` directory and all bot folders are preserved across updates.

Official versions are distributed through GitHub Releases:

[![Latest Release](https://img.shields.io/github/v/release/Julien48003/nexus-bot-manager?style=flat-square)](https://github.com/Julien48003/nexus-bot-manager/releases)

## 🤖 Available templates

Nexus ships with 9 built-in templates covering the most common community needs:

| Template | Use case | Difficulty |
|----------|----------|------------|
| **Discord.js — Minimal** | Quick start, blank bot | Débutant |
| **Discord.js — Slash Commands** | Modular architecture with REST deploy | Intermédiaire |
| **Discord.js — Vérification & Règles** | Auto-assign member role on rules accept | Débutant |
| **Discord.js — Accueil & Onboarding** | Welcome messages, auto-role, leave messages | Débutant |
| **Discord.js — Tickets Support** | Private channels via button | Intermédiaire |
| **Discord.js — Modération** | `/warn` `/mute` `/kick` `/ban` `/clear` with logs | Intermédiaire |
| **Discord.js — Rôles & Auto-rôles** | Reaction/button roles + join auto-role | Débutant |
| **Discord.js — Système de niveaux** | XP per message, `/rank` command | Intermédiaire |
| **Discord.js — Auto-modération** | Bad words, anti-spam, anti-link filter | Intermédiaire |

Each template ships with a complete `README.md`, `.env.example` and proper Discord intents.

---

## 🐛 Issues

Found a bug or have a suggestion?

[![Issues](https://img.shields.io/github/issues/Julien48003/nexus-bot-manager?style=flat-square)](https://github.com/Julien48003/nexus-bot-manager/issues)

When reporting an issue, include:

* Nexus version
* Operating system
* Node.js version
* Relevant error messages
* Relevant logs
* Steps to reproduce the problem

**Never include passwords, Discord bot tokens, JWT secrets or other sensitive information in an issue.**

---

## 🤝 Contributing

Contributions, bug reports and suggestions are welcome.

To contribute:

1. Fork the repository.
2. Create a branch for your changes.
3. Implement your changes.
4. Test them.
5. Open a pull request.

---

## 📚 Resources

[![Website](https://img.shields.io/badge/Website-nexus.dj--julien.fr-111827?style=flat-square)](https://nexus.dj-julien.fr)
[![Documentation](https://img.shields.io/badge/Docs-nexus.dj--julien.fr-111827?style=flat-square)](https://nexus.dj-julien.fr/docs.html)
[![Releases](https://img.shields.io/badge/Releases-GitHub-111827?style=flat-square\&logo=github)](https://github.com/Julien48003/nexus-bot-manager/releases)
[![Issues](https://img.shields.io/github/issues/Julien48003/nexus-bot-manager?style=flat-square)](https://github.com/Julien48003/nexus-bot-manager/issues)

---

<p align="center">

**Nexus Bot Manager**

*Self-hosted. Web-based. Built for Discord bots.*

</p>
