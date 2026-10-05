> **This is a fork.** [fribbels/hsr-optimizer](https://github.com/fribbels/hsr-optimizer) is upstream and remains the source of truth. This fork adds an AI automation layer on top of the same optimizer engine — see [docs/dev/ai-automation.md](docs/dev/ai-automation.md).

# About

Tools for optimizing your Honkai Star Rail builds, including the Character Optimizer and Relic Scorer.

### Optimizer https://fribbels.github.io/hsr-optimizer/

![image](https://github.com/user-attachments/assets/fccde7c3-c2ec-4d26-bd94-ed36b6f4c231)

### Relic scorer https://fribbels.github.io/hsr-optimizer/#showcase

![image](https://github.com/user-attachments/assets/08729229-da7d-459f-b969-538b07672d50)

### Relic organizer and recommendations

<img width="1367" alt="image" src="https://github.com/fribbels/hsr-optimizer/assets/7908525/1274f519-7df7-413d-b97a-4f0e202d67fb">

# Contact

Drop by the discord server for ideas/bugs/questions or just to hang out! https://discord.gg/rDmB4Un7qg

We're happy to have new contributors! Please reach out on the discord server #dev channel - we would love a hand on new
features.

- Contributing information: https://github.com/fribbels/hsr-optimizer/blob/main/CONTRIBUTING.md

# Development

See [CONTRIBUTING.md](https://github.com/fribbels/hsr-optimizer/blob/main/CONTRIBUTING.md) for full setup instructions.

```
git clone --filter=blob:none https://github.com/fribbels/hsr-optimizer.git
```

## AI automation (fork addition)

A structured browser API plus an MCP stdio bridge that drives the existing optimizer engine from an AI session: save and scan import, inventory lookup, simulation, CPU/GPU search, build and batch management, in-optimizer equipment swaps and candidate allocation. The robot icon in the header opens a live AI activity panel showing each call's status, timing and payload, and can pull the AI session's save into the page. Setup, the tool list and the client config live in [docs/dev/ai-automation.md](docs/dev/ai-automation.md) (written in Chinese).

Requires Node.js 26 (see `.nvmrc`), npm 11 and Chrome or Microsoft Edge. Clone this fork rather than upstream:

```
git clone --filter=blob:none https://github.com/Asaiuta/hsr-optimizer.git
cd hsr-optimizer
npm ci
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

Then register `scripts/automation-mcp.mts` as an MCP server.

# Credits

Shout outs to:

- All the code contributors that made this project possible! You guys are the best!
- Floods - for adding i18n support, various features and maintenance
- IceDynamix - for Reliquary Archiver and Estimated TBP
- Emma - for Reliquary Archiver and live import
- Dim - for providing the data files
- Jingna Zhang - for UI design and direction
- Kel-Z - for building & maintaining the relic scanner
- Enka.Network - for the relic scorer API
