# Crypto Trend Monitor

## Overview
A real-time crypto monitoring agent built to scan emerging token activity, apply custom quality filters, score potential opportunities, and send automated alerts.

The project also includes a dashboard UI for visualizing alert activity, reject reasons, scoring behavior, and market signal flow.

## Tech Stack
- Node.js
- JavaScript (ES Modules)
- Axios
- DexScreener API
- Discord Webhooks
- Telegram Bot API
- dotenv
- HTML/CSS/JavaScript

## Core Features
- Polls live token profile and pair data from DexScreener
- Applies rule-based filtering for liquidity, volume, price movement, buy pressure, age, and allowed DEX/quote pairs
- Scores candidate alerts and sorts them before dispatch
- Sends alerts to Discord and optionally Telegram
- Persists dedupe/cooldown state locally to reduce spam
- Includes a dashboard interface for monitoring alert behavior and system activity

## Files
- `index.js` — main monitoring and alert engine
- `dashboard.html` — dashboard UI for visualizing alerts and agent activity

## Notes
Environment variables are required for Discord and optional Telegram integrations. Runtime files such as `.state.json`, `alerts.json`, and `.env` should not be committed.
