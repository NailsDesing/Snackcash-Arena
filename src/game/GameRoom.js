import { creditUserWallet, debitUserWallet } from '../services/supabase.js';

const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const STATE_SNAPSHOT_TICKS = 2; // 12.5 Hz: posicao, direcao e estado principal
const BODY_SNAPSHOT_TICKS = 5; // 5 Hz: corpos completos/compactados
const MAX_NETWORK_SEGMENTS = 240;
const BODY_COLLISION_RADIUS = 15;
const INPUT_INTERVAL_MS = 50; // 20 entradas por segundo
const BOOST_ACTIVATION_COST = 0.10;
const BOOST_MIN_SCORE = 12.28;
const BOOST_MASS_LOSS_PER_SECOND = 1.25;
const FLY_PROTECTION_SECONDS = 30;

const COLORS = ['#4bd8ff', '#ff5f88', '#ff9b42', '#bd70ff', '#52e06f', '#ffdd57', '#5d7cff', '#ff70d7'];
const BOT_NAMES = ['Lunna', 'Kira', 'Thorz', 'Zenitsu', 'Malu', 'Biscoito', 'CapivaraRJ', 'ShadowBR', 'NinjaSP', 'Valkyrie'];

export class GameRoom {
  constructor(io) {
    this.io = io;
    this.players = new Map(); // socketId -> snake
    this.activeUserIds = new Set(); // impede múltiplas partidas simultâneas por conta
    this.bots = [];
    this.foods = [];
    this.valueOrbs = [];
    this.hazardHoles = [
      { x: -520, y: -280, r: 31 },
      { x: 710, y: 430, r: 34 },
      { x: -890, y: 620, r: 29 }
    ];
    this.portals = [
      { x: 520, y: -520, r: 34, pair: 1 },
      { x: -680, y: 410, r: 34, pair: 1 },
      { x: -1050, y: -530, r: 34, pair: 2 },
      { x: 980, y: 720, r: 34, pair: 2 }
    ];
    this.house = { x: 310, y: 260, r: 45 };
    this.houseMoveTimer = 90;
    this.platformFee = 0.30;
    this.targetBots = 6;
    this.targetFoods = 260;
    this.broadcastTick = 0;
    this.recentlyCollectedFoods = [];
    this.activeSnakes = [];
    this.eventState = 'idle';
    this.eventTimer = 15;
    this.wizards = [];
    this.powerFly = null;
    this.flyTimer = rnd(20, 35);

    // Inicializar mundo
    this.initFoods();
    this.initBots();

    // Loop do jogo (25 ticks por segundo = 40ms)
    this.tickInterval = setInterval(() => this.tick(0.04), 40);
  }

  initFoods() {
    const missing = Math.max(0, this.targetFoods - this.foods.length);
    for (let i = 0; i < missing; i++) {
      this.foods.push({
        id: Math.random().toString(36).substring(2, 9),
        x: rnd(-1600, 1600),
        y: rnd(-1600, 1600),
        r: rnd(2.2, 4.2),
        h: rnd(150, 320),
        rewardEligible: true
      });
    }
  }

  initBots() {
    for (let i = 0; i < this.targetBots; i++) {
      this.spawnBot(i);
    }
  }

  createSnake({ id, name, isPlayer = false, tier = 10, color = null }) {
    const value = tier;
    const mass = tier === 20 ? 38 : 24;
    const angle = rnd(0, TAU);
    const x = rnd(-800, 800);
    const y = rnd(-800, 800);
    const segments = [];
    for (let i = 0; i < mass; i++) {
      segments.push({ x: x - Math.cos(angle) * i * 7, y: y - Math.sin(angle) * i * 7 });
    }

    return {
      id,
      name: name || 'Rival',
      isPlayer,
      x,
      y,
      angle,
      targetAngle: angle,
      speed: isPlayer ? 155 : rnd(95, 130),
      mass,
      score: mass,
      value,
      bank: value,
      color: color || COLORS[Math.floor(rnd(0, COLORS.length))],
      segments,
      alive: true,
      boosting: false,
      boostExhausted: false,
      boost: 100,
      inputLastAppliedAt: 0,
      pendingInput: null,
      grace: isPlayer ? 2.5 : 1.2,
      portalCooldown: 0,
      invulnerable: 0,
      inSafeHouse: false,
      platformOrbProgress: 0,
      turnTimer: rnd(0.5, 2),
      bodyMinX: Math.min(segments[0].x, segments[segments.length - 1].x),
      bodyMaxX: Math.max(segments[0].x, segments[segments.length - 1].x),
      bodyMinY: Math.min(segments[0].y, segments[segments.length - 1].y),
      bodyMaxY: Math.max(segments[0].y, segments[segments.length - 1].y)
    };
  }

  spawnBot(i) {
    const tier = Math.random() < 0.4 ? 20 : 10;
    const bot = this.createSnake({
      id: `bot_${Math.random().toString(36).substring(2, 7)}`,
      name: BOT_NAMES[i % BOT_NAMES.length],
      isPlayer: false,
      tier,
      color: COLORS[i % COLORS.length]
    });
    this.bots.push(bot);
  }

  async addPlayer(socket, { name, tier }) {
    const userId = socket.user?.id;
    if (!userId) {
      socket.emit('arena_error', { message: 'Sessão autenticada obrigatória para entrar na arena.' });
      return;
    }
    if (this.players.has(socket.id) || this.activeUserIds.has(userId)) {
      socket.emit('arena_error', { message: 'Esta conta já possui uma partida ativa.' });
      return;
    }

    const requestedTier = Number(tier);
    const entryTier = Number.isFinite(requestedTier) && requestedTier === 20 ? 20 : 10;
    try {
      await debitUserWallet(userId, entryTier, 'match_entry', `Entrada na arena (Cobra R$ ${entryTier})`);
    } catch (err) {
      socket.emit('arena_error', { message: err.message || 'Saldo insuficiente para entrar na arena.' });
      return;
    }

    // O primeiro jogador sempre começa em uma arena limpa. Antes disso os bots
    // não devem deixar resíduos de partidas que ninguém estava acompanhando.
    if (this.players.size === 0) {
      this.valueOrbs = [];
      this.recentlyCollectedFoods = [];
      this.wizards = [];
      this.powerFly = null;
      this.flyTimer = rnd(20, 35);
      this.eventState = 'idle';
      this.eventTimer = 15;
    }

    const snake = this.createSnake({
      id: socket.id,
      name: name || 'Jogador',
      isPlayer: true,
      tier: entryTier,
      color: entryTier === 20 ? '#ffc13b' : '#33efa2'
    });
    snake.userId = userId;

    this.players.set(socket.id, snake);
    this.activeUserIds.add(userId);

    // Enviar confirmação e dados iniciais do mundo para o jogador
    socket.emit('joined_arena', {
      myId: socket.id,
      snake: {
        x: snake.x,
        y: snake.y,
        angle: snake.angle,
        mass: snake.mass,
        bank: snake.bank,
        color: snake.color
      },
      house: this.house,
      hazardHoles: this.hazardHoles,
      portals: this.portals,
      powerFly: this.serializePowerFly(),
      foods: this.serializeFoods()
    });
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (player && player.alive) this.killSnake(player, 'Desconectou da arena', false);
    if (player?.userId) this.activeUserIds.delete(player.userId);
    this.players.delete(socketId);
  }

  handlePlayerInput(socketId, data = {}) {
    const player = this.players.get(socketId);
    if (!player || !player.alive || player.inSafeHouse) return;

    const input = {};
    if (Number.isFinite(data.targetAngle)) input.targetAngle = data.targetAngle;
    if (typeof data.boosting === 'boolean') input.boosting = data.boosting;
    if (!Object.hasOwn(input, 'targetAngle') && !Object.hasOwn(input, 'boosting')) return;

    const now = Date.now();
    if (now - player.inputLastAppliedAt < INPUT_INTERVAL_MS) {
      const pending = player.pendingInput || (player.pendingInput = {});
      if (Number.isFinite(input.targetAngle)) pending.targetAngle = input.targetAngle;
      if (typeof input.boosting === 'boolean') pending.boosting = input.boosting;
      return;
    }
    this.applyPlayerInput(player, input, now);
  }

  applyPlayerInput(player, input, now = Date.now()) {
    if (Number.isFinite(input.targetAngle)) {
      player.targetAngle = Math.atan2(Math.sin(input.targetAngle), Math.cos(input.targetAngle));
    }

    if (typeof input.boosting === 'boolean' && input.boosting !== player.boosting) {
      if (input.boosting) {
        if (player.bank < BOOST_ACTIVATION_COST || player.score <= BOOST_MIN_SCORE || player.boost <= 0) {
          player.boosting = false;
          this.io.to(player.id).emit('boost_result', {
            active: false,
            bank: player.bank,
            message: player.bank < BOOST_ACTIVATION_COST
              ? 'Valor insuficiente para ativar o impulso.'
              : 'Massa ou energia insuficiente para ativar o impulso.'
          });
        } else {
          player.bank = Math.round((player.bank - BOOST_ACTIVATION_COST) * 100) / 100;
          player.boosting = true;
          player.boostExhausted = false;
          this.io.to(player.id).emit('boost_result', {
            active: true,
            charged: BOOST_ACTIVATION_COST,
            bank: player.bank
          });
        }
      } else {
        player.boosting = false;
        player.boostExhausted = false;
      }
    }

    player.inputLastAppliedAt = now;
    player.pendingInput = null;
  }

  flushPendingInput(player, now) {
    if (!player.pendingInput || now - player.inputLastAppliedAt < INPUT_INTERVAL_MS) return;
    const pending = player.pendingInput;
    player.pendingInput = null;
    this.applyPlayerInput(player, pending, now);
  }

  async handleCashout(socketId, data = {}) {
    const player = this.players.get(socketId);
    if (!player || !player.alive || player.cashoutInProgress) return;

    if (!player.inSafeHouse && dist2(player, this.house) > (this.house.r + 35) ** 2) {
      this.io.to(socketId).emit('cashout_result', { success: false, message: 'Você precisa estar dentro da Casa Segura!' });
      return;
    }

    const finish = data.finish === true;
    const requestedAmount = Number(data.amount);
    if (!finish && (!Number.isFinite(requestedAmount) || requestedAmount <= 0)) {
      this.io.to(socketId).emit('cashout_result', { success: false, message: 'Valor de retirada inválido.' });
      return;
    }

    const val = Math.round((finish ? player.bank : Math.min(player.bank, requestedAmount)) * 100) / 100;
    if (!Number.isFinite(val) || val <= 0) return;

    player.cashoutInProgress = true;
    try {
      await creditUserWallet(player.userId, val, 'match_cashout', `Retirada na Casa Segura (R$ ${val.toFixed(2)})`);
      const bankBeforeCashout = player.bank;
      player.bank = Math.round((player.bank - val) * 100) / 100;

      if (!finish && bankBeforeCashout > 0) {
        const remainingRatio = Math.max(0, Math.min(1, player.bank / bankBeforeCashout));
        player.score = Math.max(8, player.score * remainingRatio);
        player.mass = Math.max(8, Math.floor(player.score));
        player.segments.length = Math.max(8, Math.min(player.segments.length, player.mass));
      }

      this.io.to(socketId).emit('cashout_result', { success: true, amount: val, finish, remainingBank: player.bank, mass: player.mass, score: player.score, segments: player.segments });
      if (finish) {
        player.alive = false;
        this.activeUserIds.delete(player.userId);
        this.players.delete(socketId);
      } else {
        this.releasePlayerFromHouse(player);
      }
    } catch (err) {
      this.io.to(socketId).emit('cashout_result', { success: false, message: err.message || 'Não foi possível confirmar a retirada.' });
    } finally {
      player.cashoutInProgress = false;
    }
  }
  handleLeaveSafeHouse(socketId) {
    const player = this.players.get(socketId);
    if (player?.alive && player.inSafeHouse) this.releasePlayerFromHouse(player);
  }

  releasePlayerFromHouse(player) {
    const newX = this.house.x + Math.cos(player.angle) * (this.house.r + 70);
    const newY = this.house.y + Math.sin(player.angle) * (this.house.r + 70);
    const dx = newX - player.x;
    const dy = newY - player.y;
    player.x = newX;
    player.y = newY;
    for (const segment of player.segments) {
      segment.x += dx;
      segment.y += dy;
    }
    player.inSafeHouse = false;
    player.grace = Math.max(player.grace, 2);
    player.invulnerable = Math.max(player.invulnerable, 2);
  }

  killSnake(s, reason, drop = true) {
    if (!s.alive) return;
    s.alive = false;
    if (s.isPlayer && s.userId) this.activeUserIds.delete(s.userId);

    if (drop && s.bank > 0) {
      const payoutCount = Math.floor(s.bank * (1 - this.platformFee) * 10);
      const body = s.segments;
      for (let i = 0; i < payoutCount; i++) {
        const p = body[i % body.length];
        const a = rnd(0, TAU);
        const rad = rnd(2, 20);
        this.valueOrbs.push({
          id: Math.random().toString(36).substring(2, 9),
          x: p.x + Math.cos(a) * rad,
          y: p.y + Math.sin(a) * rad,
          r: 5,
          value: 0.10,
          life: 120
        });
      }
      // Proteção adicional contra picos quando várias cobras morrem juntas.
      if (this.valueOrbs.length > 1500) {
        this.valueOrbs.splice(0, this.valueOrbs.length - 1500);
      }
    }

    if (s.isPlayer) {
      this.io.to(s.id).emit('player_died', {
        reason: reason || 'Sua cobra foi derrotada.',
        mass: s.mass,
        earned: 0
      });
    } else {
      // Repor bot após um intervalo
      setTimeout(() => {
        if (this.bots.length < this.targetBots) {
          this.spawnBot(Math.floor(rnd(0, 10)));
        }
      }, 2500);
    }
  }

  tick(dt) {
    // Orbes abandonados precisam expirar. Sem esta limpeza, cada morte de bot
    // aumentava permanentemente o estado enviado a todos os navegadores.
    let writeIndex = 0;
    for (let i = 0; i < this.valueOrbs.length; i++) {
      const orb = this.valueOrbs[i];
      orb.life -= dt;
      if (orb.life > 0) this.valueOrbs[writeIndex++] = orb;
    }
    this.valueOrbs.length = writeIndex;

    writeIndex = 0;
    for (let i = 0; i < this.recentlyCollectedFoods.length; i++) {
      const item = this.recentlyCollectedFoods[i];
      item.life -= dt;
      if (item.life > 0) this.recentlyCollectedFoods[writeIndex++] = item;
    }
    this.recentlyCollectedFoods.length = writeIndex;

    // Não simular batalhas entre bots quando a sala estiver vazia. Isso evita
    // que o próximo jogador receba centenas de orbes de mortes anteriores.
    if (this.players.size === 0) {
      this.valueOrbs.length = 0;
      this.recentlyCollectedFoods.length = 0;
      this.wizards.length = 0;
      this.powerFly = null;
      this.flyTimer = rnd(20, 35);
      this.eventState = 'idle';
      this.eventTimer = 15;
      return;
    }

    // 1. Atualizar temporizador da Casa Segura
    this.houseMoveTimer -= dt;
    if (this.houseMoveTimer <= 0) {
      this.houseMoveTimer = rnd(75, 110);
      const a = rnd(0, TAU);
      const rad = rnd(600, 1100);
      this.house.x = Math.cos(a) * rad;
      this.house.y = Math.sin(a) * rad;
      for (const player of this.players.values()) player.inSafeHouse = false;
      this.io.emit('house_relocated', { house: this.house });
    }

    const allSnakes = this.activeSnakes;
    allSnakes.length = 0;
    for (const snake of this.players.values()) if (snake.alive) allSnakes.push(snake);
    for (const snake of this.bots) if (snake.alive) allSnakes.push(snake);
    const inputNow = Date.now();
    for (const player of this.players.values()) this.flushPendingInput(player, inputNow);
    this.updatePowerFly(dt, allSnakes);
    this.updateWizards(dt, allSnakes);

    // 2. Atualizar cada cobra
    for (const s of allSnakes) {
      s.grace = Math.max(0, s.grace - dt);
      s.portalCooldown = Math.max(0, s.portalCooldown - dt);
      s.invulnerable = Math.max(0, s.invulnerable - dt);
      if (s.inSafeHouse) {
        s.boosting = false;
        s.boostExhausted = false;
        continue;
      }

      // Comportamento da IA dos Bots
      if (!s.isPlayer) {
        s.turnTimer -= dt;
        if (s.turnTimer <= 0) {
          s.turnTimer = rnd(0.8, 2.2);
          // Procura comida mais próxima
          let nearest = null;
          let minD = 200000;
          const foodSearchLimit = Math.min(30, this.foods.length);
          for (let foodIndex = 0; foodIndex < foodSearchLimit; foodIndex++) {
            const f = this.foods[foodIndex];
            const d = dist2(s, f);
            if (d < minD) {
              minD = d;
              nearest = f;
            }
          }
          if (nearest) {
            s.targetAngle = Math.atan2(nearest.y - s.y, nearest.x - s.x);
          } else {
            s.targetAngle += rnd(-1.2, 1.2);
          }
        }
      }

      // Rotação suave
      const turnRate = s.isPlayer ? 3.8 : 2.2;
      const angleDiff = Math.atan2(Math.sin(s.targetAngle - s.angle), Math.cos(s.targetAngle - s.angle));
      s.angle += clamp(angleDiff, -turnRate * dt, turnRate * dt);

      // Boost
      const activeBoost = s.boosting && !s.boostExhausted && s.boost > 0 && s.score > BOOST_MIN_SCORE;
      if (activeBoost) {
        s.boost = Math.max(0, s.boost - dt * 35);
        s.score = Math.max(BOOST_MIN_SCORE, s.score - BOOST_MASS_LOSS_PER_SECOND * dt);
        s.mass = Math.max(12, Math.floor(s.score));
        while (s.segments.length > s.mass) s.segments.pop();
        if (s.boost <= 0 || s.score <= BOOST_MIN_SCORE) s.boostExhausted = true;
      } else {
        s.boost = Math.min(100, s.boost + dt * 10);
      }

      const currentSpeed = s.speed * (activeBoost ? 1.6 : 1.0);
      s.x += Math.cos(s.angle) * currentSpeed * dt;
      s.y += Math.sin(s.angle) * currentSpeed * dt;

      if (s.isPlayer && dist2(s, this.house) < (this.house.r + 12) ** 2) {
        s.inSafeHouse = true;
        s.boosting = false;
        this.io.to(s.id).emit('safe_house_entered', { bank: s.bank });
        continue;
      }

      // Atualizar corpo
      s.segments[0].x = s.x;
      s.segments[0].y = s.y;
      let bodyMinX = s.x;
      let bodyMaxX = s.x;
      let bodyMinY = s.y;
      let bodyMaxY = s.y;
      const gap = 7.1;
      for (let i = 1; i < s.segments.length; i++) {
        const prev = s.segments[i - 1];
        const cur = s.segments[i];
        const dx = prev.x - cur.x;
        const dy = prev.y - cur.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > gap) {
          const k = (d - gap) / d;
          cur.x += dx * k;
          cur.y += dy * k;
        }
        if (cur.x < bodyMinX) bodyMinX = cur.x;
        else if (cur.x > bodyMaxX) bodyMaxX = cur.x;
        if (cur.y < bodyMinY) bodyMinY = cur.y;
        else if (cur.y > bodyMaxY) bodyMaxY = cur.y;
      }
      s.bodyMinX = bodyMinX;
      s.bodyMaxX = bodyMaxX;
      s.bodyMinY = bodyMinY;
      s.bodyMaxY = bodyMaxY;

      // 3. Coleta de Comida & Orbes
      for (let i = this.foods.length - 1; i >= 0; i--) {
        const f = this.foods[i];
        // Jogadores recebem uma margem de coleta maior para compensar os
        // intervalos entre snapshots e a interpolação visual do navegador.
        const pickupRadius = s.isPlayer ? 36 : 14;
        if (dist2(s, f) < (pickupRadius + f.r) ** 2) {
          this.foods.splice(i, 1);
          this.recentlyCollectedFoods.push({ id: f.id, life: 3 });
          s.score += 0.05;
          s.platformOrbProgress++;
          let reward = 0;
          if (s.platformOrbProgress >= 5) {
            const rewards = Math.floor(s.platformOrbProgress / 5);
            s.platformOrbProgress %= 5;
            reward = rewards * 0.01;
            s.bank = Math.round((s.bank + reward) * 100) / 100;
          }
          s.mass = Math.max(8, Math.floor(s.score));
          while (s.segments.length < s.mass) {
            const last = s.segments[s.segments.length - 1];
            s.segments.push({ x: last.x, y: last.y });
          }
          if (s.isPlayer) {
            this.io.to(s.id).emit('food_collected', {
              id: f.id,
              reward,
              bank: s.bank,
              mass: s.mass,
              progress: s.platformOrbProgress
            });
          }
        }
      }

      for (let i = this.valueOrbs.length - 1; i >= 0; i--) {
        const o = this.valueOrbs[i];
        if (dist2(s, o) < (16 + o.r) ** 2) {
          this.valueOrbs.splice(i, 1);
          s.bank = Math.round((s.bank + o.value) * 100) / 100;
          s.score += 0.25;
          s.mass = Math.floor(s.score);
        }
      }

      // 4. Buracos de Perigo (Formigueiros)
      for (const h of this.hazardHoles) {
        if (dist2(s, h) < (h.r + 8) ** 2) {
          this.killSnake(s, 'Caiu no formigueiro e perdeu a cobra.', false);
          break;
        }
      }

      // Portais pareados transportam a cobra inteira para a outra saída.
      if (s.alive && s.portalCooldown <= 0) {
        for (const portal of this.portals) {
          if (dist2(s, portal) >= (portal.r + 8) ** 2) continue;
          const exit = this.portals.find(p => p !== portal && p.pair === portal.pair);
          if (exit) {
            const newX = exit.x + Math.cos(s.angle) * 75;
            const newY = exit.y + Math.sin(s.angle) * 75;
            const dx = newX - s.x;
            const dy = newY - s.y;
            s.x = newX;
            s.y = newY;
            for (const segment of s.segments) {
              segment.x += dx;
              segment.y += dy;
            }
            s.bodyMinX += dx;
            s.bodyMaxX += dx;
            s.bodyMinY += dy;
            s.bodyMaxY += dy;
            s.portalCooldown = 2;
            s.invulnerable = Math.max(s.invulnerable, 0.5);
          }
          break;
        }
      }
    }

    // 5. Colisão entre cobras
    for (let i = 0; i < allSnakes.length; i++) {
      const s1 = allSnakes[i];
      if (!s1.alive || s1.inSafeHouse || s1.grace > 0) continue;
      for (let j = i + 1; j < allSnakes.length; j++) {
        const s2 = allSnakes[j];
        if (!s2.alive || s2.inSafeHouse || s2.grace > 0 || s1.invulnerable > 0 || s2.invulnerable > 0) continue;
        if (dist2(s1, s2) < 576) {
          const loser = s1.bank < s2.bank ? s1 : (s1.mass < s2.mass ? s1 : s2);
          this.killSnake(loser, 'Colisão frontal com cobra mais forte.');
          if (loser === s1) break;
        }
      }
    }

    // Rejeita corpos distantes pela caixa espacial antes de varrer segmentos.
    for (let i = 0; i < allSnakes.length; i++) {
      const s1 = allSnakes[i];
      if (!s1.alive || s1.inSafeHouse || s1.grace > 0 || s1.invulnerable > 0) continue;
      for (let j = 0; j < allSnakes.length; j++) {
        if (i === j) continue;
        const s2 = allSnakes[j];
        if (!s2.alive || s2.inSafeHouse) continue;
        if (s1.x < s2.bodyMinX - BODY_COLLISION_RADIUS ||
            s1.x > s2.bodyMaxX + BODY_COLLISION_RADIUS ||
            s1.y < s2.bodyMinY - BODY_COLLISION_RADIUS ||
            s1.y > s2.bodyMaxY + BODY_COLLISION_RADIUS) continue;

        for (let segIdx = 4; segIdx < s2.segments.length; segIdx += 2) {
          if (dist2(s1, s2.segments[segIdx]) < 225) {
            this.killSnake(s1, `Encostou no corpo de ${s2.name}.`);
            break;
          }
        }
        if (!s1.alive) break;
      }
    }

    // Limpar bots mortos
    writeIndex = 0;
    for (let i = 0; i < this.bots.length; i++) {
      if (this.bots[i].alive) this.bots[writeIndex++] = this.bots[i];
    }
    this.bots.length = writeIndex;

    // Repor comida se necessário
    if (this.foods.length < this.targetFoods) {
      this.initFoods();
    }

    // 6. Transmitir estado da sala para os jogadores conectados
    this.broadcastState(allSnakes);
  }

  spawnPowerFly() {
    let anchor = null;
    for (const player of this.players.values()) {
      if (player.alive && !player.inSafeHouse) { anchor = player; break; }
    }
    if (!anchor) return;
    const angle = rnd(0, TAU);
    const radius = rnd(300, 620);
    this.powerFly = {
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius,
      angle: rnd(0, TAU),
      r: 11,
      life: 18,
      turnTimer: 0.1,
      phase: rnd(0, TAU)
    };
  }

  updatePowerFly(dt) {
    if (!this.powerFly) {
      this.flyTimer -= dt;
      if (this.flyTimer <= 0) {
        this.spawnPowerFly();
        if (!this.powerFly) this.flyTimer = 2;
      }
      return;
    }

    const fly = this.powerFly;
    fly.life -= dt;
    fly.turnTimer -= dt;
    let target = null;
    let best = Infinity;
    for (const player of this.players.values()) {
      if (!player.alive || player.inSafeHouse) continue;
      const distance = dist2(fly, player);
      if (distance < best) { best = distance; target = player; }
    }

    if (fly.turnTimer <= 0) {
      fly.turnTimer = rnd(0.16, 0.36);
      if (target) {
        const toward = Math.atan2(target.y - fly.y, target.x - fly.x);
        fly.angle = best > 720 ** 2 ? toward + rnd(-0.45, 0.45) : toward + rnd(-1.65, 1.65);
      } else {
        fly.angle += rnd(-1.2, 1.2);
      }
    }
    fly.x += Math.cos(fly.angle) * 145 * dt;
    fly.y += Math.sin(fly.angle) * 145 * dt;

    if (target && dist2(fly, target) < (fly.r + 15) ** 2) {
      target.invulnerable = FLY_PROTECTION_SECONDS;
      this.powerFly = null;
      this.flyTimer = rnd(42, 65);
      this.io.to(target.id).emit('power_fly_collected', { duration: FLY_PROTECTION_SECONDS });
    } else if (fly.life <= 0) {
      this.powerFly = null;
      this.flyTimer = rnd(28, 50);
    }
  }

  updateWizards(dt, allSnakes) {
    this.eventTimer -= dt;
    if (this.eventTimer <= 0) {
      if (this.eventState === 'idle') {
        this.eventState = 'active';
        this.eventTimer = 60;
        const anchor = allSnakes.find(s => s.isPlayer) || { x: 0, y: 0 };
        this.wizards = Array.from({ length: 3 }, (_, i) => {
          const a = i * TAU / 3 + rnd(-0.35, 0.35);
          const rad = rnd(650, 950);
          return { x: anchor.x + Math.cos(a) * rad, y: anchor.y + Math.sin(a) * rad, angle: a + Math.PI, r: 24, trail: [], phase: rnd(0, TAU), fleeing: false };
        });
      } else {
        this.eventState = 'idle';
        this.eventTimer = 45;
        this.wizards = [];
      }
    }

    if (!this.wizards.length) return;
    for (let wi = this.wizards.length - 1; wi >= 0; wi--) {
      const wizard = this.wizards[wi];
      let protectedPlayer = null;
      let protectedDistance = 900 ** 2;
      for (const snake of allSnakes) {
        if (!snake.alive || !snake.isPlayer || snake.inSafeHouse || snake.invulnerable <= 0) continue;
        const distance = dist2(wizard, snake);
        if (distance < protectedDistance) { protectedDistance = distance; protectedPlayer = snake; }
      }

      let target = null;
      let best = Infinity;
      if (!protectedPlayer) {
        for (const snake of allSnakes) {
          if (!snake.alive || snake.inSafeHouse || snake.invulnerable > 0) continue;
          const d = dist2(wizard, snake);
          if (d < best) { best = d; target = snake; }
        }
      }
      wizard.fleeing = !!protectedPlayer;
      const wanted = protectedPlayer
        ? Math.atan2(wizard.y - protectedPlayer.y, wizard.x - protectedPlayer.x)
        : target ? Math.atan2(target.y - wizard.y, target.x - wizard.x) : wizard.angle + 0.35;
      const diff = Math.atan2(Math.sin(wanted - wizard.angle), Math.cos(wanted - wizard.angle));
      const turnRate = protectedPlayer ? 3.1 : 2.25;
      const speed = protectedPlayer ? 195 : 175;
      wizard.angle += clamp(diff, -turnRate * dt, turnRate * dt);
      wizard.x += Math.cos(wizard.angle) * speed * dt;
      wizard.y += Math.sin(wizard.angle) * speed * dt;
      wizard.trail.unshift({ x: wizard.x, y: wizard.y });
      if (wizard.trail.length > 24) wizard.trail.pop();

      for (const snake of allSnakes) {
        if (!snake.alive || snake.inSafeHouse || dist2(wizard, snake) >= (wizard.r + 13) ** 2) continue;
        if (snake.invulnerable > 0) {
          this.wizards.splice(wi, 1);
          if (snake.isPlayer) this.io.to(snake.id).emit('wizard_defeated', { rewarded: false });
        }
        else this.killSnake(snake, snake.isPlayer ? 'Uma cobra de fogo alcançou você.' : null, snake.isPlayer);
        break;
      }
    }
  }

  broadcastState(allSnakes = this.activeSnakes) {
    if (this.players.size === 0) return;

    this.broadcastTick++;
    const sendState = this.broadcastTick % STATE_SNAPSHOT_TICKS === 0;
    const sendBodies = this.broadcastTick % BODY_SNAPSHOT_TICKS === 0;
    if (!sendState && !sendBodies) return;

    const liveSnakes = [];
    for (const snake of allSnakes) if (snake.alive) liveSnakes.push(snake);

    // O corpo viaja em um canal separado, somente 5 vezes por segundo.
    if (sendBodies) {
      const bodies = [];
      for (const snake of liveSnakes) {
        const source = snake.segments;
        const stride = Math.max(1, Math.ceil(source.length / MAX_NETWORK_SEGMENTS));
        const segments = [];
        for (let i = 0; i < source.length; i += stride) {
          const segment = source[i];
          segments.push({ x: Math.round(segment.x * 10) / 10, y: Math.round(segment.y * 10) / 10 });
        }
        const last = source[source.length - 1];
        const sampledLast = source[(segments.length - 1) * stride];
        if (last && sampledLast !== last) {
          segments.push({ x: Math.round(last.x * 10) / 10, y: Math.round(last.y * 10) / 10 });
        }
        bodies.push({ id: snake.id, segmentCount: source.length, segments });
      }
      for (const [socketId, viewer] of this.players) {
        if (viewer.alive) this.io.to(socketId).emit('arena_bodies', { snakes: bodies });
      }
    }

    if (!sendState) return;

    const snakesData = [];
    for (const snake of liveSnakes) {
      snakesData.push({
        id: snake.id,
        name: snake.name,
        isPlayer: snake.isPlayer,
        x: Math.round(snake.x * 10) / 10,
        y: Math.round(snake.y * 10) / 10,
        angle: Math.round(snake.angle * 100) / 100,
        mass: snake.mass,
        bank: snake.bank,
        platformOrbProgress: snake.platformOrbProgress,
        boost: Math.round(snake.boost * 10) / 10,
        invulnerable: Math.round(snake.invulnerable * 10) / 10,
        inSafeHouse: snake.inSafeHouse,
        color: snake.color
      });
    }

    const removedFoodIds = [];
    for (const item of this.recentlyCollectedFoods) removedFoodIds.push(item.id);

    const wizardsData = [];
    for (const wizard of this.wizards) {
      const trail = [];
      for (const point of wizard.trail) {
        trail.push({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
      }
      wizardsData.push({
        x: Math.round(wizard.x * 10) / 10,
        y: Math.round(wizard.y * 10) / 10,
        angle: Math.round(wizard.angle * 100) / 100,
        r: wizard.r,
        phase: wizard.phase,
        fleeing: wizard.fleeing,
        trail
      });
    }

    const sendItems = this.broadcastTick % 4 === 0;
    const foodRadius2 = 1800 ** 2;
    const orbRadius2 = 1500 ** 2;
    for (const [socketId, viewer] of this.players) {
      if (!viewer.alive) continue;
      const state = {
        snakes: snakesData,
        eventState: this.eventState,
        eventTimer: Math.round(this.eventTimer * 10) / 10,
        powerFly: this.serializePowerFly(),
        removedFoodIds,
        wizards: wizardsData
      };
      if (sendItems) {
        const foods = [];
        for (const food of this.foods) {
          if (dist2(viewer, food) <= foodRadius2) foods.push(this.serializeFood(food));
        }
        const valueOrbs = [];
        for (let i = this.valueOrbs.length - 1; i >= 0 && valueOrbs.length < 500; i--) {
          const orb = this.valueOrbs[i];
          if (dist2(viewer, orb) > orbRadius2) continue;
          valueOrbs.push({
            id: orb.id,
            x: Math.round(orb.x),
            y: Math.round(orb.y),
            r: orb.r,
            life: Math.round(orb.life * 10) / 10
          });
        }
        valueOrbs.reverse();
        state.foods = foods;
        state.valueOrbs = valueOrbs;
      }
      this.io.to(socketId).emit('arena_state', state);
    }
  }

  serializeFoods() {
    return this.foods.map(f => this.serializeFood(f));
  }

  serializePowerFly() {
    if (!this.powerFly) return null;
    return {
      x: Math.round(this.powerFly.x * 10) / 10,
      y: Math.round(this.powerFly.y * 10) / 10,
      angle: Math.round(this.powerFly.angle * 100) / 100,
      r: this.powerFly.r,
      life: Math.round(this.powerFly.life * 10) / 10,
      phase: this.powerFly.phase
    };
  }

  serializeFood(f) {
    return {
      id: f.id,
      x: Math.round(f.x),
      y: Math.round(f.y),
      r: Number(f.r.toFixed(1)),
      h: Math.round(f.h),
      rewardEligible: f.rewardEligible
    };
  }
}
