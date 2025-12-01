const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static('public'));

// Game state
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 600;
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 4;
const PUNCH_RANGE = 50;
const PUNCH_FORCE = 150;
const FLAG_PICKUP_RANGE = 40;
const WIN_SCORE = 3;

let players = {};
let flag = {
    x: CANVAS_WIDTH / 2,
    y: CANVAS_HEIGHT / 2,
    carrier: null
};

const goals = {
    red: { x: 20, y: CANVAS_HEIGHT / 2 - 75, w: 60, h: 150 },
    blue: { x: CANVAS_WIDTH - 80, y: CANVAS_HEIGHT / 2 - 75, w: 60, h: 150 }
};

let scores = { red: 0, blue: 0 };

// Player class
class Player {
    constructor(id, name, team) {
        this.id = id;
        this.name = name;
        this.team = team;
        this.x = team === 'red' ? 150 : CANVAS_WIDTH - 150;
        this.y = CANVAS_HEIGHT / 2;
        this.vx = 0;
        this.vy = 0;
        this.r = PLAYER_RADIUS;
        this.angle = 0;
        this.stunned = false;
        this.stunnedTime = 0;
        this.punchCooldown = 0;
    }

    update(input) {
        if (this.stunned) {
            this.stunnedTime--;
            if (this.stunnedTime <= 0) {
                this.stunned = false;
                this.vx *= 0.5;
                this.vy *= 0.5;
            }
        }

        if (this.punchCooldown > 0) {
            this.punchCooldown--;
        }

        if (!this.stunned && input.keys) {
            let moveX = 0;
            let moveY = 0;

            if (input.keys.w) moveY -= 1;
            if (input.keys.s) moveY += 1;
            if (input.keys.a) moveX -= 1;
            if (input.keys.d) moveX += 1;

            // Normalize diagonal movement
            if (moveX !== 0 && moveY !== 0) {
                moveX *= 0.707;
                moveY *= 0.707;
            }

            this.vx = moveX * PLAYER_SPEED;
            this.vy = moveY * PLAYER_SPEED;
        } else {
            this.vx *= 0.9;
            this.vy *= 0.9;
        }

        // Update position
        this.x += this.vx;
        this.y += this.vy;

        // Boundary collision
        if (this.x - this.r < 0) {
            this.x = this.r;
            this.vx = 0;
        }
        if (this.x + this.r > CANVAS_WIDTH) {
            this.x = CANVAS_WIDTH - this.r;
            this.vx = 0;
        }
        if (this.y - this.r < 0) {
            this.y = this.r;
            this.vy = 0;
        }
        if (this.y + this.r > CANVAS_HEIGHT) {
            this.y = CANVAS_HEIGHT - this.r;
            this.vy = 0;
        }

        // Update angle based on mouse
        if (input.mouse) {
            const dx = input.mouse.x - CANVAS_WIDTH / 2;
            const dy = input.mouse.y - CANVAS_HEIGHT / 2;
            this.angle = Math.atan2(dy, dx);
        }

        // Update flag position if carrying
        if (flag.carrier === this.id) {
            flag.x = this.x;
            flag.y = this.y;
        }
    }

    punch() {
        if (this.punchCooldown > 0 || this.stunned) return false;
        this.punchCooldown = 30; // 0.5 second cooldown at 60fps
        return true;
    }

   getHit(angle) {
    this.stunned = true;
    this.stunnedTime = 30;
    this.vx = Math.cos(angle) * PUNCH_FORCE;
    this.vy = Math.sin(angle) * PUNCH_FORCE;

    // Drop flag if carrying
    if (flag.carrier === this.id) {
        flag.carrier = null;
        flag.x = this.x + Math.cos(angle) * 150;
        flag.y = this.y + Math.sin(angle) * 150;
    }
}


    toJSON() {
        return {
            id: this.id,
            name: this.name,
            team: this.team,
            x: this.x,
            y: this.y,
            r: this.r,
            angle: this.angle
        };
    }
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        // Remove player
        if (ws.playerId) {
            // Drop flag if carrying
            if (flag.carrier === ws.playerId) {
                flag.carrier = null;
                const player = players[ws.playerId];
                if (player) {
                    flag.x = player.x;
                    flag.y = player.y;
                }
            }
            delete players[ws.playerId];
            broadcast({ type: 'update', players: getPlayersData(), flag, scores });
            console.log(`Player ${ws.playerId} disconnected`);
        }
    });
});

function handleMessage(ws, data) {
    switch(data.type) {
        case 'join':
            const id = generateId();
            ws.playerId = id;
            players[id] = new Player(id, data.name, data.team);
            
            // Send init data to new player
            ws.send(JSON.stringify({
                type: 'init',
                id: id,
                players: getPlayersData(),
                flag: flag,
                goals: goals,
                scores: scores
            }));

            // Broadcast to all players
            broadcast({ type: 'update', players: getPlayersData(), flag, scores });
            console.log(`Player ${data.name} joined ${data.team} team`);
            break;

        case 'input':
            if (players[ws.playerId]) {
                players[ws.playerId].update(data);
            }
            break;

        case 'punch':
            if (players[ws.playerId] && players[ws.playerId].punch()) {
                performPunch(ws.playerId, data.angle);
            }
            break;

        case 'pickFlag':
            if (players[ws.playerId]) {
                pickOrDropFlag(ws.playerId);
            }
            break;
    }
}

function performPunch(attackerId, angle) {
    const attacker = players[attackerId];
    if (!attacker) return;

    // Check if any player is in punch range
    for (let id in players) {
        if (id === attackerId) continue;
        const target = players[id];
        const dx = target.x - attacker.x;
        const dy = target.y - attacker.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < PUNCH_RANGE) {
            // ✅ Fix: define hit angle correctly
            const hitAngle = Math.atan2(dy, dx);
            target.getHit(hitAngle);
        }
    }
}


function pickOrDropFlag(playerId) {
    const player = players[playerId];
    if (!player) return;

    if (flag.carrier === playerId) {
        // Drop flag
        flag.carrier = null;
        flag.x = player.x;
        flag.y = player.y;
    } else if (!flag.carrier) {
        // Pick up flag
        const dx = flag.x - player.x;
        const dy = flag.y - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < FLAG_PICKUP_RANGE) {
            flag.carrier = playerId;
        }
    }
}

function checkGoals() {
    if (!flag.carrier) return;

    const carrier = players[flag.carrier];
    if (!carrier) return;

    // Check red goal (blue team scores)
    if (carrier.team === 'blue' &&
        carrier.x > goals.red.x && carrier.x < goals.red.x + goals.red.w &&
        carrier.y > goals.red.y && carrier.y < goals.red.y + goals.red.h) {
        
        scores.blue++;
        resetFlag();
        resetPlayers();

        if (scores.blue >= WIN_SCORE) {
            broadcast({ type: 'win', team: 'blue' });
            resetGame();
        }
    }

    // Check blue goal (red team scores)
    if (carrier.team === 'red' &&
        carrier.x > goals.blue.x && carrier.x < goals.blue.x + goals.blue.w &&
        carrier.y > goals.blue.y && carrier.y < goals.blue.y + goals.blue.h) {
        
        scores.red++;
        resetFlag();
        resetPlayers();

        if (scores.red >= WIN_SCORE) {
            broadcast({ type: 'win', team: 'red' });
            resetGame();
        }
    }
}

function resetFlag() {
    flag.x = CANVAS_WIDTH / 2;
    flag.y = CANVAS_HEIGHT / 2;
    flag.carrier = null;
}

function resetPlayers() {
    for (let id in players) {
        const p = players[id];
        p.x = p.team === 'red' ? 150 : CANVAS_WIDTH - 150;
        p.y = CANVAS_HEIGHT / 2;
        p.vx = 0;
        p.vy = 0;
        p.stunned = false;
    }
}

function resetGame() {
    setTimeout(() => {
        scores = { red: 0, blue: 0 };
        resetFlag();
        resetPlayers();
        broadcast({ type: 'update', players: getPlayersData(), flag, scores });
    }, 3000);
}

function getPlayersData() {
    const data = {};
    for (let id in players) {
        data[id] = players[id].toJSON();
    }
    return data;
}

function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

// Game loop (60 FPS)
setInterval(() => {
    checkGoals();
    broadcast({ type: 'update', players: getPlayersData(), flag, scores });
}, 1000 / 60);

// Start server
const PORT = process.env.PORT || 4577;
server.listen(PORT, () => {
    console.log(`Bomb Squad server running on port ${PORT}`);
});

app.listen(4576, () => {
  console.log(`Server listening at http://localhost:${4576}`);
});