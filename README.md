# scc-isa-voice

SCC ISA voice training relay

## Overview

This project is a Node.js server for SCC ISA voice training, featuring scenario management and admin alerting via email, Slack, or webhook.

## Features

- Scenario management via `scenarios.json`
- Admin alerts via email, Slack, or webhook
- Configurable via environment variables
- Node.js 18 support

## Getting Started

### Prerequisites

- Node.js 18 (use `nvm use` if you have nvm)
- npm

### Installation

1. Clone the repository:
    ```sh
    git clone <your-repo-url>
    cd scc-isa-voice
    ```

2. Install dependencies:
    ```sh
    npm install
    ```

3. Copy `.env.example` to `.env` and fill in your real values:
    ```sh
    cp .env.example .env
    # Edit .env with your SMTP/email/webhook/Slack settings
    ```

### Running the Server

```sh
npm start
