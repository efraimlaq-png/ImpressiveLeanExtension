require('dotenv').config();
const {
    Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
    ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder,
    ChannelType, PermissionFlagsBits, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const cron = require('cron');
const fs = require('fs');
const path = require('path');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });
const eventosAtivos = new Map();
const configuracoesPorGuild = new Map();
const CONFIG_PATH = path.join(__dirname, 'guild-config.json');
const XP_PATH = path.join(__dirname, 'xp-config.json');
const REGISTROS_PATH = path.join(__dirname, 'registros-canais.json');
const EVENTOS_PATH = path.join(__dirname, 'eventos-ativos.json');
const SALDOS_PATH = path.join(__dirname, 'saldos-membros.json');
const xpMembros = new Map();
const registrosCanais = new Map();
const saldosMembros = new Map();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const TIME_ZONE = process.env.TIME_ZONE || 'America/Sao_Paulo';
const MINUTOS_ABERTURA_SALA = 30;
const MAX_OPCOES_MENU = 25;
const DIAS_RETENCAO_REGISTROS = 5;
const DIAS_RETENCAO_REGISTROS_LEILAO = 30;
const TEMPO_RETENCAO_REGISTROS_MS = DIAS_RETENCAO_REGISTROS * 24 * 60 * 60 * 1000;
const TEMPO_RETENCAO_REGISTROS_LEILAO_MS = DIAS_RETENCAO_REGISTROS_LEILAO * 24 * 60 * 60 * 1000;

if (!DISCORD_TOKEN || !CLIENT_ID) {
    console.error('Erro: configure DISCORD_TOKEN e CLIENT_ID no arquivo .env antes de iniciar o bot.');
    process.exit(1);
}

// ==========================================
// BANCOS DE DADOS LOCAIS (JSON)
// ==========================================
function carregarDados() {
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const dados = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            Object.entries(dados).forEach(([guildId, config]) => {
                if (config?.categoriaId && config?.cargoEventoId) configuracoesPorGuild.set(guildId, config);
            });
        } catch (e) { console.error('Erro ao ler guild-config.json', e); }
    }
    if (fs.existsSync(XP_PATH)) {
        try {
            const dados = JSON.parse(fs.readFileSync(XP_PATH, 'utf8'));
            Object.entries(dados).forEach(([chave, xp]) => xpMembros.set(chave, xp));
        } catch (e) { console.error('Erro ao ler xp-config.json', e); }
    }
    if (fs.existsSync(REGISTROS_PATH)) {
        try {
            const dados = JSON.parse(fs.readFileSync(REGISTROS_PATH, 'utf8'));
            Object.entries(dados).forEach(([channelId, registro]) => registrosCanais.set(channelId, registro));
        } catch (e) { console.error('Erro ao ler registros-canais.json', e); }
    }
    if (fs.existsSync(EVENTOS_PATH)) {
        try {
            const dados = JSON.parse(fs.readFileSync(EVENTOS_PATH, 'utf8'));
            Object.entries(dados).forEach(([eventoId, evento]) => {
                if (!evento?.id || !Array.isArray(evento.grupos)) return;
                evento.grupos.forEach(grupo => normalizarGrupoPersistido(grupo));
                eventosAtivos.set(eventoId, evento);
            });
        } catch (e) { console.error('Erro ao ler eventos-ativos.json', e); }
    }
    if (fs.existsSync(SALDOS_PATH)) {
        try {
            const dados = JSON.parse(fs.readFileSync(SALDOS_PATH, 'utf8'));
            Object.entries(dados).forEach(([chave, saldo]) => saldosMembros.set(chave, normalizarSaldoMembro(saldo)));
        } catch (e) { console.error('Erro ao ler saldos-membros.json', e); }
    }
}

function salvarDados() {
    try {
        const objetoConfig = Object.fromEntries(configuracoesPorGuild.entries());
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(objetoConfig, null, 2), 'utf8');

        const objetoXP = Object.fromEntries(xpMembros.entries());
        fs.writeFileSync(XP_PATH, JSON.stringify(objetoXP, null, 2), 'utf8');

        const objetoRegistros = Object.fromEntries(registrosCanais.entries());
        fs.writeFileSync(REGISTROS_PATH, JSON.stringify(objetoRegistros, null, 2), 'utf8');

        const objetoEventos = Object.fromEntries(eventosAtivos.entries());
        fs.writeFileSync(EVENTOS_PATH, JSON.stringify(objetoEventos, null, 2), 'utf8');

        const objetoSaldos = Object.fromEntries(saldosMembros.entries());
        fs.writeFileSync(SALDOS_PATH, JSON.stringify(objetoSaldos, null, 2), 'utf8');
    } catch (e) { console.error('Erro ao salvar arquivos de banco de dados locais', e); }
}
carregarDados();

// ==========================================
// FUNÇÕES AUXILIARES DE CÁLCULO E TEMPO
// ==========================================
function obterAnoMes(date = new Date()) {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(date);
    const ano = partes.find(p => p.type === 'year')?.value;
    const mes = partes.find(p => p.type === 'month')?.value;
    return `${ano}-${mes}`;
}

function obterChaveXp(guildId, userId, date = new Date()) {
    return `${guildId}_${obterAnoMes(date)}_${userId}`;
}

function membroPodeCriarEvento(interaction, configGuild) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    return Boolean(configGuild?.cargoEventoId && interaction.member?.roles?.cache?.has(configGuild.cargoEventoId));
}

function membroTemCargoLeilao(interaction, configGuild) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    return Boolean(configGuild?.cargoLeilaoId && interaction.member?.roles?.cache?.has(configGuild.cargoLeilaoId));
}

async function usuarioPodeOperarLeilao(interaction, guildId) {
    const configGuild = configuracoesPorGuild.get(guildId);
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (interaction.member?.roles?.cache?.has(configGuild?.cargoLeilaoId)) return true;
    if (!configGuild?.cargoLeilaoId) return false;

    const guild = interaction.guild || client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const membro = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;
    return Boolean(membro?.roles?.cache?.has(configGuild.cargoLeilaoId));
}

function horarioValido(horario) {
    if (!/^\d{1,2}:\d{2}$/.test(horario || '')) return false;
    const [hora, minuto] = horario.split(':').map(Number);
    return Number.isInteger(hora) && Number.isInteger(minuto) && hora >= 0 && hora <= 23 && minuto >= 0 && minuto <= 59;
}

function criarSlug(texto, fallback = 'evento') {
    const slug = String(texto || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60);
    return slug || fallback;
}

const ROLE_SLUGS = {
    TANK: 'TANK',
    HEALER: 'HEALER',
    SUPORTE: 'SUPORTE',
    DPS: 'DPS',
    'DPS RANGER': 'DPS_RANGER'
};
const SLUG_TO_ROLE = Object.fromEntries(Object.entries(ROLE_SLUGS).map(([role, slug]) => [slug, role]));

function roleParaSlug(role) {
    return ROLE_SLUGS[role] || String(role).replace(/\s+/g, '_');
}

function slugParaRole(slug) {
    return SLUG_TO_ROLE[slug] || String(slug).replace(/_/g, ' ');
}

function normalizarIndexGrupo(indexGrupo) {
    return parseInt(indexGrupo, 10);
}

function extrairIdEvento(customId, prefixo) {
    return customId.startsWith(prefixo) ? customId.slice(prefixo.length) : null;
}

function recarregarEventoDoDisco(idEvento) {
    if (!fs.existsSync(EVENTOS_PATH)) return null;
    try {
        const dados = JSON.parse(fs.readFileSync(EVENTOS_PATH, 'utf8'));
        const evento = dados[idEvento];
        if (!evento?.id || !Array.isArray(evento.grupos)) return null;
        evento.grupos.forEach(grupo => normalizarGrupoPersistido(grupo));
        eventosAtivos.set(idEvento, evento);
        return evento;
    } catch (e) {
        console.error('Erro ao recarregar evento do disco:', e);
        return null;
    }
}

function buscarEventoPorMensagemPrincipal(messageId, guildId) {
    for (const [, evento] of eventosAtivos) {
        if (evento.mensagemPrincipalId === messageId && evento.guildId === guildId) return evento;
    }
    return null;
}

function obterEvento(idEvento, interaction = null) {
    let evento = eventosAtivos.get(idEvento);
    if (!evento) evento = recarregarEventoDoDisco(idEvento);
    if (!evento && interaction?.message?.id && interaction.guild?.id) {
        evento = buscarEventoPorMensagemPrincipal(interaction.message.id, interaction.guild.id);
    }
    return evento;
}

function removerEventoPersistido(idEvento) {
    eventosAtivos.delete(idEvento);
    salvarDados();
}

const parseWeapons = (input) => {
    if (!input || input.toLowerCase() === '0' || input.toLowerCase() === 'nenhuma') return [];
    const armas = [];
    const itens = input.split(',').map(s => s.trim()).filter(s => s !== '');
    for (const item of itens) {
        let nomeArma = item; let quantidade = 1;
        const sufixo = item.match(/^(.*?)\s*(?:\*|x)\s*(\d+)$/i);
        const prefixo = item.match(/^(\d+)\s*(?:\*|x)\s*(.*?)$/i);
        const sufixoSemSeparador = item.match(/^(.*?[^\d\s])\s*(\d+)$/i);
        if (sufixo) { nomeArma = sufixo[1].trim(); quantidade = parseInt(sufixo[2], 10); }
        else if (prefixo) { quantidade = parseInt(prefixo[1], 10); nomeArma = prefixo[2].trim(); }
        else if (sufixoSemSeparador) { nomeArma = sufixoSemSeparador[1].trim(); quantidade = parseInt(sufixoSemSeparador[2], 10); }
        if (!nomeArma || Number.isNaN(quantidade) || quantidade <= 0) continue;
        for (let i = 0; i < quantidade; i++) armas.push(nomeArma);
    }
    return armas;
};

function getAvailableWeapons(requiredArray, participantsArray) {
    let available = [...requiredArray];
    participantsArray.forEach(p => {
        const idx = available.indexOf(p.arma);
        if (idx !== -1) available.splice(idx, 1);
    });
    return available;
}

function minutosAteHorario(horario) {
    if (!horarioValido(horario)) return null;
    const [horaGrupo, minGrupo] = horario.split(':').map(Number);
    const formatter = new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const [horaAtualStr, minAtualStr] = formatter.format(new Date()).split(':');
    const minAtualTotal = parseInt(horaAtualStr) * 60 + parseInt(minAtualStr);
    const minGrupoTotal = horaGrupo * 60 + minGrupo;
    let diferenca = minGrupoTotal - minAtualTotal;
    if (diferenca < 0) diferenca += 1440;
    return diferenca;
}

function formatarDuracaoMs(totalMs) {
    const ms = Math.max(0, totalMs);
    const totalSegundos = Math.floor(ms / 1000);
    const horas = Math.floor(totalSegundos / 3600);
    const minutos = Math.floor((totalSegundos % 3600) / 60);
    const segundos = totalSegundos % 60;
    if (horas > 0) return `${horas}h ${String(minutos).padStart(2, '0')}m ${String(segundos).padStart(2, '0')}s`;
    if (minutos > 0) return `${minutos}m ${String(segundos).padStart(2, '0')}s`;
    return `${segundos}s`;
}

function tempoTotalAtual(participante) {
    let add = (!participante.isPaused && participante.lastStartMs) ? (Date.now() - participante.lastStartMs) : 0;
    return participante.totalMs + add;
}

function parseValorPrata(valor) {
    return parseInt(String(valor || '0').replace(/\D/g, ''), 10) || 0;
}

function parsePercentualDesconto(valor, padrao = 20) {
    const texto = String(valor ?? '').replace('%', '').replace(',', '.').trim();
    const numero = Number.parseFloat(texto);
    if (!Number.isFinite(numero)) return padrao;
    return Math.min(100, Math.max(0, numero));
}

function formatarPercentual(valor) {
    return `${parsePercentualDesconto(valor).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

function formatarPrata(valor) {
    return `${Math.max(0, Math.floor(Number(valor) || 0)).toLocaleString('pt-BR')} Pratas`;
}

function chaveSaldo(guildId, userId) {
    return `${guildId}_${userId}`;
}

function normalizarSaldoMembro(saldo) {
    const normalizado = {
        guildId: saldo?.guildId || null,
        userId: saldo?.userId || null,
        lancamentos: Array.isArray(saldo?.lancamentos) ? saldo.lancamentos : [],
        resgates: Array.isArray(saldo?.resgates) ? saldo.resgates : []
    };

    normalizado.lancamentos = normalizado.lancamentos.map(lancamento => ({
        id: String(lancamento.id || ''),
        guildId: lancamento.guildId || normalizado.guildId,
        userId: lancamento.userId || normalizado.userId,
        eventoId: lancamento.eventoId || null,
        grupoIndex: Number.isInteger(lancamento.grupoIndex) ? lancamento.grupoIndex : parseInt(lancamento.grupoIndex ?? 0, 10),
        tipo: lancamento.tipo || 'split',
        descricao: lancamento.descricao || 'Split',
        valor: Math.max(0, Math.floor(Number(lancamento.valor) || 0)),
        status: lancamento.status || 'disponivel',
        criadoEmMs: lancamento.criadoEmMs || Date.now(),
        solicitadoEmMs: lancamento.solicitadoEmMs || null,
        pagoEmMs: lancamento.pagoEmMs || null,
        pagoPorId: lancamento.pagoPorId || null,
        resgateId: lancamento.resgateId || null
    })).filter(lancamento => lancamento.id);

    normalizado.resgates = normalizado.resgates.map(resgate => ({
        id: String(resgate.id || ''),
        valorTotal: Math.max(0, Math.floor(Number(resgate.valorTotal) || 0)),
        status: resgate.status || 'solicitado',
        solicitadoEmMs: resgate.solicitadoEmMs || Date.now(),
        pagoEmMs: resgate.pagoEmMs || null,
        pagoPorId: resgate.pagoPorId || null,
        lancamentoIds: Array.isArray(resgate.lancamentoIds) ? resgate.lancamentoIds : []
    })).filter(resgate => resgate.id);

    return normalizado;
}

function obterSaldoMembro(guildId, userId) {
    const chave = chaveSaldo(guildId, userId);
    const existente = saldosMembros.get(chave);
    if (existente) return existente;
    const novo = { guildId, userId, lancamentos: [], resgates: [] };
    saldosMembros.set(chave, novo);
    return novo;
}

function idLancamentoSacola(eventoId, indexGrupo, userId) {
    return `sacola_${eventoId}_${normalizarIndexGrupo(indexGrupo)}_${userId}`;
}

function idLancamentoBau(eventoId, indexGrupo, userId) {
    return `bau_${eventoId}_${normalizarIndexGrupo(indexGrupo)}_${userId}`;
}

function registrarLancamentoSaldo(guildId, userId, lancamento) {
    if (!lancamento?.id || !lancamento.valor) return null;
    const saldo = obterSaldoMembro(guildId, userId);
    const atual = saldo.lancamentos.find(item => item.id === lancamento.id);
    if (atual) {
        Object.assign(atual, { ...lancamento, status: atual.status, resgateId: atual.resgateId, solicitadoEmMs: atual.solicitadoEmMs, pagoEmMs: atual.pagoEmMs, pagoPorId: atual.pagoPorId });
        return atual;
    }
    const novo = {
        guildId,
        userId,
        status: 'disponivel',
        criadoEmMs: Date.now(),
        solicitadoEmMs: null,
        pagoEmMs: null,
        pagoPorId: null,
        resgateId: null,
        ...lancamento
    };
    saldo.lancamentos.push(novo);
    return novo;
}

function marcarLancamentoSaldoPago(guildId, userId, lancamentoId, pagoPorId) {
    const saldo = obterSaldoMembro(guildId, userId);
    const lancamento = saldo.lancamentos.find(item => item.id === lancamentoId);
    if (!lancamento) return false;
    lancamento.status = 'pago';
    lancamento.pagoEmMs = Date.now();
    lancamento.pagoPorId = pagoPorId;
    if (lancamento.resgateId) {
        const resgate = saldo.resgates.find(item => item.id === lancamento.resgateId);
        const todosPagos = resgate?.lancamentoIds?.every(id => saldo.lancamentos.find(item => item.id === id)?.status === 'pago');
        if (resgate && todosPagos) {
            resgate.status = 'pago';
            resgate.pagoEmMs = Date.now();
            resgate.pagoPorId = pagoPorId;
        }
    }
    return true;
}

function registrarSplitSacolaNoSaldo(evento, indexGrupo, resultado) {
    if (!resultado?.valor) return null;
    const idx = normalizarIndexGrupo(indexGrupo);
    return registrarLancamentoSaldo(evento.guildId, resultado.userId, {
        id: idLancamentoSacola(evento.id, idx, resultado.userId),
        eventoId: evento.id,
        grupoIndex: idx,
        tipo: 'sacolas',
        descricao: `Sacolas - ${evento.nome} | Grupo ${idx + 1}`,
        valor: resultado.valor
    });
}

function registrarSplitBauNoSaldo(evento, indexGrupo, resultado, origem) {
    if (!resultado?.valor) return null;
    const idx = normalizarIndexGrupo(indexGrupo);
    return registrarLancamentoSaldo(evento.guildId, resultado.userId, {
        id: idLancamentoBau(evento.id, idx, resultado.userId),
        eventoId: evento.id,
        grupoIndex: idx,
        tipo: 'bau',
        descricao: `${origem || 'Baú'} - ${evento.nome} | Grupo ${idx + 1}`,
        valor: resultado.valor
    });
}

function marcarSacolaPagaNoSaldo(evento, indexGrupo, userId, pagoPorId) {
    return marcarLancamentoSaldoPago(evento.guildId, userId, idLancamentoSacola(evento.id, indexGrupo, userId), pagoPorId);
}

function obterSacolaTotal(grupo) {
    return Math.max(0, Math.floor(Number(grupo?.sacolaTotal ?? grupo?.lootTotal ?? 0) || 0));
}

function definirSacolaTotal(grupo, valor) {
    const total = Math.max(0, Math.floor(Number(valor) || 0));
    grupo.sacolaTotal = total;
    grupo.lootTotal = total;
}

function criarEstadoBauPadrao() {
    return {
        status: 'nao_informado',
        printUrl: null,
        localLoot: null,
        descontoPercentual: 20,
        valorBruto: 0,
        valorReparo: 0,
        valorLiquido: 0,
        decisao: null,
        compradorId: null,
        valorPago: 0,
        splitFinal: null,
        leilao: null
    };
}

function normalizarSplitSacolasPersistido(splitSacolas) {
    if (!splitSacolas || typeof splitSacolas !== 'object') return null;
    splitSacolas.resultados = Array.isArray(splitSacolas.resultados) ? splitSacolas.resultados : [];
    splitSacolas.resultados.forEach(resultado => {
        resultado.pago = Boolean(resultado.pago);
        resultado.valor = Math.max(0, Math.floor(Number(resultado.valor) || 0));
        resultado.tempoMs = Math.max(0, Math.floor(Number(resultado.tempoMs) || 0));
        resultado.xpGanho = Number(resultado.xpGanho) || 0;
    });
    splitSacolas.totalSacolas = Math.max(0, Math.floor(Number(splitSacolas.totalSacolas) || 0));
    splitSacolas.totalMs = Math.max(0, Math.floor(Number(splitSacolas.totalMs) || 0));
    splitSacolas.falhasDmParticipantes = Array.isArray(splitSacolas.falhasDmParticipantes) ? splitSacolas.falhasDmParticipantes : [];
    return splitSacolas;
}

function normalizarBauPersistido(bau) {
    const normalizado = { ...criarEstadoBauPadrao(), ...(bau && typeof bau === 'object' ? bau : {}) };
    normalizado.valorBruto = Math.max(0, Math.floor(Number(normalizado.valorBruto) || 0));
    normalizado.valorReparo = Math.max(0, Math.floor(Number(normalizado.valorReparo) || 0));
    normalizado.valorLiquido = Math.max(0, Math.floor(Number(normalizado.valorLiquido ?? (normalizado.valorBruto - normalizado.valorReparo)) || 0));
    normalizado.valorPago = Math.max(0, Math.floor(Number(normalizado.valorPago) || 0));
    normalizado.localLoot = normalizado.localLoot ? limitarTexto(normalizado.localLoot, 80) : null;
    normalizado.descontoPercentual = parsePercentualDesconto(normalizado.descontoPercentual, 20);
    if (normalizado.splitFinal?.resultados) {
        normalizado.splitFinal.resultados = normalizado.splitFinal.resultados.map(resultado => ({
            userId: resultado.userId,
            tempoMs: Math.max(0, Math.floor(Number(resultado.tempoMs) || 0)),
            valor: Math.max(0, Math.floor(Number(resultado.valor) || 0))
        }));
    }
    if (normalizado.leilao) {
        normalizado.leilao.lanceInicial = Math.max(0, Math.floor(Number(normalizado.leilao.lanceInicial) || 0));
        normalizado.leilao.maiorLance = Math.max(0, Math.floor(Number(normalizado.leilao.maiorLance) || 0));
    }
    return normalizado;
}

function membroEstaNaSalaVoz(guild, grupo, userId) {
    if (!guild || !grupo?.canalVozId) return false;
    return guild.voiceStates.cache.get(userId)?.channelId === grupo.canalVozId;
}

function iniciarCronometroParticipante(participante) {
    if (!participante.isPaused && !participante.lastStartMs) participante.lastStartMs = Date.now();
}

function pararCronometroParticipante(participante) {
    if (participante.lastStartMs) {
        participante.totalMs += Date.now() - participante.lastStartMs;
        participante.lastStartMs = null;
    }
}

function togglePause(participante) {
    if (participante.isPaused) {
        participante.isPaused = false;
    } else {
        pararCronometroParticipante(participante);
        participante.isPaused = true;
    }
}

function normalizarGrupoPersistido(grupo) {
    grupo.participantes = Array.isArray(grupo.participantes) ? grupo.participantes : [];
    grupo.participantes.forEach(p => { p.lastStartMs = null; });
    grupo.fechado = Boolean(grupo.fechado);
    definirSacolaTotal(grupo, obterSacolaTotal(grupo));
    grupo.splitSacolas = normalizarSplitSacolasPersistido(grupo.splitSacolas);
    grupo.bau = normalizarBauPersistido(grupo.bau);
    grupo.conteudoEstado = grupo.conteudoEstado || 'aguardando';
    grupo.conteudoTempoAcumuladoMs = grupo.conteudoTempoAcumuladoMs || 0;
    if (grupo.conteudoEstado === 'rodando') {
        if (grupo.conteudoRodandoDesdeMs) {
            grupo.conteudoTempoAcumuladoMs += Math.max(0, Date.now() - grupo.conteudoRodandoDesdeMs);
        }
        grupo.conteudoEstado = 'pausado';
        grupo.conteudoRodandoDesdeMs = null;
    }
}

function tempoConteudoAtual(grupo) {
    let ms = grupo.conteudoTempoAcumuladoMs || 0;
    if (grupo.conteudoEstado === 'rodando' && grupo.conteudoRodandoDesdeMs) {
        ms += Date.now() - grupo.conteudoRodandoDesdeMs;
    }
    return ms;
}

function obterStatusConteudoGrupo(grupo) {
    const tempo = formatarDuracaoMs(tempoConteudoAtual(grupo));
    if (grupo.conteudoEstado === 'rodando') return `▶️ Conteúdo em andamento — ${tempo}`;
    if (grupo.conteudoEstado === 'pausado') return `⏸️ Conteúdo pausado — ${tempo}`;
    return `⏳ Aguardando Play do líder — ${tempo}`;
}

function emojiStatusParticipante(grupo, participante) {
    if (participante.isPaused) return '⏸️';
    if (grupo.conteudoEstado !== 'rodando') return '⏳';
    if (participante.lastStartMs) return '▶️';
    return '🔇';
}

function pausarConteudoGrupo(grupo) {
    if (grupo.conteudoEstado === 'rodando' && grupo.conteudoRodandoDesdeMs) {
        grupo.conteudoTempoAcumuladoMs = (grupo.conteudoTempoAcumuladoMs || 0) + (Date.now() - grupo.conteudoRodandoDesdeMs);
        grupo.conteudoRodandoDesdeMs = null;
    }
    grupo.conteudoEstado = 'pausado';
    grupo.participantes.forEach(p => pararCronometroParticipante(p));
}

function retomarConteudoGrupo(guild, grupo) {
    if (!grupo.conteudoInicioMs) grupo.conteudoInicioMs = Date.now();
    grupo.conteudoEstado = 'rodando';
    grupo.conteudoRodandoDesdeMs = Date.now();
    sincronizarCronometrosGrupo(guild, grupo);
}

function iniciarConteudoGrupo(guild, grupo) {
    if (!grupo.conteudoInicioMs) grupo.conteudoInicioMs = Date.now();
    grupo.conteudoEstado = 'rodando';
    grupo.conteudoRodandoDesdeMs = Date.now();
    sincronizarCronometrosGrupo(guild, grupo);
}

function alternarConteudoGrupo(guild, grupo) {
    if (grupo.conteudoEstado === 'rodando') {
        pausarConteudoGrupo(grupo);
        return 'pausado';
    }
    if (grupo.conteudoEstado === 'pausado') {
        retomarConteudoGrupo(guild, grupo);
        return 'rodando';
    }
    iniciarConteudoGrupo(guild, grupo);
    return 'rodando';
}

function finalizarConteudoGrupo(grupo) {
    pausarConteudoGrupo(grupo);
}

function sincronizarParticipanteSeElegivel(guild, grupo, participante) {
    if (grupo.conteudoEstado !== 'rodando' || participante.isPaused) {
        pararCronometroParticipante(participante);
        return;
    }
    if (membroEstaNaSalaVoz(guild, grupo, participante.id)) iniciarCronometroParticipante(participante);
    else pararCronometroParticipante(participante);
}

function deveAbrirSalaGrupo(grupo) {
    if (!grupo?.inicioPrevistoMs || grupo.canalVozId) return false;
    return Date.now() >= grupo.inicioPrevistoMs - (MINUTOS_ABERTURA_SALA * 60 * 1000);
}

function sincronizarCronometrosGrupo(guild, grupo) {
    if (!guild || !grupo?.canalVozId || grupo.fechado) return;
    if (grupo.conteudoEstado !== 'rodando') {
        grupo.participantes.forEach(p => pararCronometroParticipante(p));
        return;
    }
    grupo.participantes.forEach(participante => sincronizarParticipanteSeElegivel(guild, grupo, participante));
}

// ==========================================
// INTERFACES (EMBEDS E DASHBOARDS)
// ==========================================
function gerarDashboardGrupo(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const sacolaFormatada = obterSacolaTotal(grupo).toLocaleString('pt-BR');
    const statusBau = textoStatusBau(grupo);

    const embed = new EmbedBuilder()
        .setTitle(`🛡️ GERENCIAMENTO DE GRUPO: BLOCO ${idx + 1}`)
        .setColor(grupo.conteudoEstado === 'rodando' ? '#2ecc71' : '#95a5a6')
        .setDescription(`**Horário Oficial:** ${grupo.horario}\n**Tempo de Conteúdo:** ⏱️ ${obterStatusConteudoGrupo(grupo)}\n**Sacolas/Prata Bruta:** 💰 \`${sacolaFormatada} Pratas\`\n**Baú:** ${statusBau}\n\n*O tempo só conta após o líder iniciar o conteúdo (Play).*`);

    let listagem = '';
    grupo.participantes.forEach(p => {
        const statusEmoji = emojiStatusParticipante(grupo, p);
        const tempo = formatarDuracaoMs(tempoTotalAtual(p));
        listagem += `${statusEmoji} \`[${tempo}]\` <@${p.id}> — **${p.role}** [${p.arma}]\n`;
    });

    adicionarCampoLongo(embed, '👥 Participantes e Cronômetros', listagem || '*Nenhum participante restando no grupo.*');

    if (grupo.fechado) {
        embed.setColor('#7f8c8d');
        embed.addFields({ name: '✅ Status', value: '*Split de sacolas fechado. Use o painel pós-fechamento para pagamentos e baú.*', inline: false });
        return { embeds: [embed], components: [] };
    }

    const btnRow1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dash_pause_self_${evento.id}_${idx}`).setLabel('Pausar/Retomar Meu Tempo').setEmoji('⏱️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`dash_leave_${evento.id}_${idx}`).setLabel('Sair do Evento').setEmoji('❌').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`dash_leader_panel_${evento.id}_${idx}`).setLabel('Painel do Líder').setEmoji('👑').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [btnRow1] };
}

function usuarioPodeGerenciarEvento(interaction, evento) {
    return Boolean(evento && (interaction.user.id === evento.lider || interaction.user.id === evento.criadoPorId));
}

function gerarPainelLiderGrupo(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    if (!grupo) {
        return { content: '❌ Este grupo não está disponível.', components: [], ephemeral: true };
    }
    if (grupo.fechado) {
        return gerarPainelPagamentosGrupo(evento, idx);
    }

    const estadoConteudo = grupo.conteudoEstado || 'aguardando';
    let labelConteudo = 'Iniciar Conteúdo (Play)';
    let emojiConteudo = '▶️';
    let styleConteudo = ButtonStyle.Success;
    if (estadoConteudo === 'rodando') {
        labelConteudo = 'Pausar Conteúdo';
        emojiConteudo = '⏸️';
        styleConteudo = ButtonStyle.Danger;
    } else if (estadoConteudo === 'pausado') {
        labelConteudo = 'Retomar Conteúdo';
        emojiConteudo = '▶️';
        styleConteudo = ButtonStyle.Success;
    }

    const btnRowConteudo = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dash_conteudo_timer_${evento.id}_${idx}`).setLabel(labelConteudo).setEmoji(emojiConteudo).setStyle(styleConteudo)
    );

    const btnRowLider = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dash_add_loot_${evento.id}_${idx}`).setLabel('Adicionar Sacolas').setEmoji('💰').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`dash_calc_split_${evento.id}_${idx}`).setLabel('Finalizar & Calcular Split').setEmoji('⚖️').setStyle(ButtonStyle.Secondary)
    );

    const componentes = [btnRowConteudo, btnRowLider];
    const opcoesMembros = grupo.participantes.map(p => ({ label: limitarTexto(`Alternar Pause: ${p.role} [${p.arma}]`), description: `Membro ID: ${p.id}`, value: p.id })).slice(0, MAX_OPCOES_MENU);
    if (opcoesMembros.length > 0) {
        componentes.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`dash_force_pause_${evento.id}_${idx}`).setPlaceholder('👑 Forçar pause/retomar de um membro...').addOptions(opcoesMembros)));
    }

    return {
        content: `👑 **Painel do Líder — Grupo ${idx + 1}**\n${obterStatusConteudoGrupo(grupo)}\n*Pausar o conteúdo pausa todos os cronômetros. Pause individual só afeta um membro.*`,
        components: componentes,
        ephemeral: true
    };
}

async function atualizarMsgDashboard(guild, evento, indexGrupo) {
    const grupo = evento?.grupos[indexGrupo];
    if (!grupo) return;
    if (!grupo.canalTextoId || !grupo.dashboardMsgId) return;
    const canalTexto = guild.channels.cache.get(grupo.canalTextoId);
    if (!canalTexto) return;
    const msg = await canalTexto.messages.fetch(grupo.dashboardMsgId).catch(() => null);
    if (msg) await msg.edit(gerarDashboardGrupo(evento, indexGrupo)).catch(() => null);
}

function obterStatusTempoGrupo(grupo) {
    if (grupo.inicioAtivoMs) return `🟢 Ativo há ${formatarDuracaoMs(Date.now() - grupo.inicioAtivoMs)}`;
    if (!grupo.inicioPrevistoMs) return '⏳ Horário inválido';
    const faltamMs = grupo.inicioPrevistoMs - Date.now();
    if (faltamMs <= 0) return '🟡 Iniciando...';
    return `⏳ Falta ${formatarDuracaoMs(faltamMs)}`;
}

async function atualizarMensagemPrincipalEvento(guild, evento) {
    if (!evento || !evento.canalMensagemId || !evento.mensagemPrincipalId) return;
    const canalMensagem = guild.channels.cache.get(evento.canalMensagemId);
    if (!canalMensagem || !canalMensagem.messages) return;
    const msgPrincipal = await canalMensagem.messages.fetch(evento.mensagemPrincipalId).catch(() => null);
    if (!msgPrincipal) return;
    await msgPrincipal.edit(gerarInterface(evento)).catch(() => null);
}

function gerarInterface(evento) {
    const totalInscritos = evento.grupos.reduce((acc, grupo) => acc + grupo.participantes.length, 0);
    const embed = new EmbedBuilder()
        .setTitle(`⚔️ EVENTO: ${evento.nome.toUpperCase()}`)
        .setColor('#e67e22')
        .setDescription(`👑 **Líder:** <@${evento.lider}>\n${textoRequisitosBuild(evento, configuracoesPorGuild.get(evento.guildId))}\n👥 **Capacidade por Grupo:** \`${evento.totalVagas}\`\n🧾 **Inscrições Totais:** \`${totalInscritos}\`\n\n*Escolha um bloco no menu abaixo para entrar.*`)
        .setFooter({ text: `Evento ID: ${evento.id}` });

    evento.grupos.forEach((g, i) => {
        const secoes = [];
        const gerarLinha = (roleKey, emoji, label) => {
            const exigidas = evento.composicao[roleKey]; if (exigidas.length === 0) return '';
            const membros = g.participantes.filter(m => m.role === roleKey);
            const livres = getAvailableWeapons(exigidas, membros);
            return [`${emoji} **${label}** \`${membros.length}/${exigidas.length}\`  ${membros.length >= exigidas.length ? '🔴 Lotado' : '🟢 Aberto'}`, `> **Inscritos**`, membros.length ? membros.map(m => `> • <@${m.id}> com \`${m.arma}\``).join('\n') : '> • *Nenhum inscrito*', `> **Armas Livres:** ${livres.length ? `\`${livres.join(' | ')}\`` : '`Nenhuma`'}`].join('\n');
        };

        const r1 = gerarLinha('TANK', '🛡️', 'TANK'); const r2 = gerarLinha('HEALER', '💚', 'HEALER'); const r3 = gerarLinha('SUPORTE', '🔮', 'SUPORTE'); const r4 = gerarLinha('DPS', '⚔️', 'DPS MELEE'); const r5 = gerarLinha('DPS RANGER', '🏹', 'DPS RANGER');
        if (r1) secoes.push(r1); if (r2) secoes.push(r2); if (r3) secoes.push(r3); if (r4) secoes.push(r4); if (r5) secoes.push(r5);

        let desc = `${g.canalVozId ? `🎧 **Sala de Voz:** <#${g.canalVozId}>` : '🎧 **Sala de Voz:** *Abre 30 minutos antes*'}\n${g.canalTextoId ? `💬 **Canal de Texto:** <#${g.canalTextoId}>` : '💬 **Canal de Texto:** *Será criado junto da sala de voz*'}\n`;
        desc += secoes.length > 0 ? `\n${secoes.join('\n\n')}` : '\n> *Nenhuma classe configurada.*';
        desc += '\n\n────────────────────────────';
        embed.addFields({ name: `🔹 GRUPO ${i + 1} | 🕒 ${g.horario} | 👥 ${g.participantes.length}/${evento.totalVagas} | ${obterStatusTempoGrupo(g)}`, value: desc, inline: false });
    });

    const menuGrupos = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_group_${evento.id}`).setPlaceholder('Selecione o Grupo/Horário...').addOptions(evento.grupos.map((g, i) => ({ label: `Grupo ${i + 1} - ${g.horario}`, description: `Vagas: ${g.participantes.length}/${evento.totalVagas}`, value: `${i}` }))));
    const botoesAcao = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`leave_all_${evento.id}`).setLabel('Sair de Todos os Grupos').setStyle(ButtonStyle.Secondary), 
        new ButtonBuilder().setCustomId(`end_event_${evento.id}`).setLabel('Encerrar Evento Definitivo').setStyle(ButtonStyle.Danger)
    );
    return { embeds: [embed], components: [menuGrupos, botoesAcao] };
}

function limitarTexto(texto, limite = 100) {
    const valor = String(texto || '');
    return valor.length > limite ? `${valor.slice(0, limite - 3)}...` : valor;
}

const VALORES_ANULADOS_CAMPO = /^(null|nulo|n\/a|na|nenhum|none|-|—)$/i;

function campoEventoInformado(valor) {
    const texto = String(valor || '').trim();
    if (!texto || VALORES_ANULADOS_CAMPO.test(texto)) return null;
    return limitarTexto(texto, 80);
}

function normalizarIpBuild(valor) {
    const campo = campoEventoInformado(valor);
    if (!campo) return null;
    if (/^ip\s*:/i.test(campo)) return campo;
    return `IP: ${campo}`;
}

function valorCampoExibicao(valor) {
    return valor || '—';
}

function normalizarTituloBuildForum(valor) {
    const texto = String(valor || '').trim();
    if (!texto || VALORES_ANULADOS_CAMPO.test(texto)) return null;
    return limitarTexto(texto, 100);
}

function obterReferenciaForumBuilds(configGuild) {
    return configGuild?.canalForumBuildsId ? `<#${configGuild.canalForumBuildsId}>` : '*canal de fórum de builds do servidor*';
}

function textoRequisitosBuild(evento, configGuild = null) {
    const linhas = [
        `⚙️ **Tier dos Equipamentos:** \`${valorCampoExibicao(evento.tierEquipamento)}\``,
        `📊 **IP da Build:** \`${valorCampoExibicao(evento.ipBuild)}\``
    ];
    if (evento.tituloBuildForum) {
        linhas.push(`📚 **Build no fórum:** procure \`${evento.tituloBuildForum}\` em ${obterReferenciaForumBuilds(configGuild)}`);
    }
    return linhas.join('\n');
}

function gerarEmbedInstrucaoBuildParticipante(evento, configGuild, dadosInscricao = {}) {
    const { grupo, horario, role, arma } = dadosInscricao;
    const embed = new EmbedBuilder()
        .setTitle(`📚 Build do evento: ${evento.nome}`)
        .setColor('#9b59b6')
        .setDescription(
            `Você foi inscrito no evento **${evento.nome}**.\n` +
            `Confira a build correta no fórum antes da raid.`
        )
        .addFields(
            {
                name: '🔎 Título para buscar no fórum',
                value: `**\`${evento.tituloBuildForum}\`**\n*Formato padrão: Conteúdo - Numeração (ex: Baú Dourado - 01)*`,
                inline: false
            },
            {
                name: '📁 Onde procurar',
                value: obterReferenciaForumBuilds(configGuild),
                inline: false
            }
        );

    if (grupo) {
        embed.addFields({
            name: '🛡️ Sua inscrição',
            value: `**Grupo ${grupo}** — ${horario || '—'}\n**Função:** ${role || '—'} | **Arma:** ${arma || '—'}`,
            inline: false
        });
    }

    embed.addFields(
        { name: '⚙️ Tier exigido', value: `\`${valorCampoExibicao(evento.tierEquipamento)}\``, inline: true },
        { name: '📊 IP exigido', value: `\`${valorCampoExibicao(evento.ipBuild)}\``, inline: true }
    );

    return embed;
}

async function enviarDmInstrucaoBuildParticipante(userId, evento, configGuild, dadosInscricao = {}) {
    if (!evento?.tituloBuildForum) return true;
    const embed = gerarEmbedInstrucaoBuildParticipante(evento, configGuild, dadosInscricao);
    return enviarDmUsuario(userId, { embeds: [embed] });
}

function dividirTextoDiscord(texto, limite = 1024) {
    const linhas = String(texto || '').split('\n');
    const blocos = [];
    let blocoAtual = '';

    for (const linha of linhas) {
        const candidato = blocoAtual ? `${blocoAtual}\n${linha}` : linha;
        if (candidato.length <= limite) {
            blocoAtual = candidato;
            continue;
        }

        if (blocoAtual) blocos.push(blocoAtual);
        if (linha.length > limite) {
            for (let i = 0; i < linha.length; i += limite) blocos.push(linha.slice(i, i + limite));
            blocoAtual = '';
        } else {
            blocoAtual = linha;
        }
    }

    if (blocoAtual) blocos.push(blocoAtual);
    return blocos.length ? blocos : ['Sem dados.'];
}

function adicionarCampoLongo(embed, nome, texto) {
    dividirTextoDiscord(texto).forEach((bloco, index) => {
        embed.addFields({ name: index === 0 ? nome : `${nome} (${index + 1})`, value: bloco });
    });
}

function urlImagemValida(url) {
    return /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(String(url || '')) || /^https?:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/\S+/i.test(String(url || ''));
}

function textoStatusBau(grupo) {
    const bau = grupo?.bau || criarEstadoBauPadrao();
    if (bau.status === 'sem_bau') return '`Sem baú registrado`';
    if (bau.status === 'aguardando_decisao') return `\`Aguardando decisão\` — Líquido estimado: **${formatarPrata(bau.valorLiquido)}**`;
    if (bau.status === 'comprado_interno') return `\`Compra interna encerrada\` — **${formatarPrata(bau.valorPago)}** pagos por <@${bau.compradorId}>`;
    if (bau.status === 'em_leilao') {
        const canal = bau.leilao?.channelId ? `<#${bau.leilao.channelId}>` : 'canal não localizado';
        const maiorLance = bau.leilao?.maiorLance ? ` — maior lance: **${formatarPrata(bau.leilao.maiorLance)}** por <@${bau.leilao.maiorLicitanteId}>` : '';
        return `\`PENDENTE - EM LEILÃO\` em ${canal}${maiorLance}`;
    }
    if (bau.status === 'vendido_leilao') return `\`Leilão encerrado\` — **${formatarPrata(bau.valorPago)}** por <@${bau.compradorId}>`;
    return '`Não informado`';
}

function calcularSplitValorPorTempo(grupo, valorTotal) {
    const totalMs = grupo.splitSacolas?.totalMs || grupo.participantes.reduce((acc, p) => acc + (p.totalMs || 0), 0);
    const total = Math.max(0, Math.floor(Number(valorTotal) || 0));
    if (totalMs <= 0) return { total, totalMs: 0, resultados: [] };
    return {
        total,
        totalMs,
        resultados: grupo.participantes.map(p => ({
            userId: p.id,
            tempoMs: p.totalMs || 0,
            valor: Math.floor(total * ((p.totalMs || 0) / totalMs))
        }))
    };
}

function gerarLinhasSplitSacolas(grupo) {
    const resultados = grupo.splitSacolas?.resultados || [];
    return resultados.map((resultado, index) => {
        const status = resultado.pago ? '[ ✅ PAGO ]' : '[ ⏳ PENDENTE ]';
        return `${index + 1}. ${status} <@${resultado.userId}> [${formatarDuracaoMs(resultado.tempoMs)}] ➜ **${formatarPrata(resultado.valor)}** *(+${Math.floor(resultado.xpGanho || 0)} XP)*`;
    });
}

function gerarLinhasSplitValor(splitFinal) {
    return (splitFinal?.resultados || []).map((resultado, index) => `${index + 1}. <@${resultado.userId}> [${formatarDuracaoMs(resultado.tempoMs)}] ➜ **${formatarPrata(resultado.valor)}**`);
}

function gerarEmbedRegistroEvento(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const split = grupo.splitSacolas;
    const embed = new EmbedBuilder()
        .setTitle(`⚖️ REGISTRO DO EVENTO - GRUPO ${idx + 1}`)
        .setColor(grupo.bau?.status === 'em_leilao' ? '#3498db' : '#f1c40f')
        .setDescription(
            `${textoRequisitosBuild(evento, configuracoesPorGuild.get(evento.guildId))}\n` +
            `💰 **Sacolas/Prata Bruta:** ${formatarPrata(split?.totalSacolas ?? obterSacolaTotal(grupo))}\n` +
            `⏱️ **Soma do Tempo Total da PT:** ${formatarDuracaoMs(split?.totalMs || 0)}\n` +
            `📍 **Local do loot:** ${grupo.bau?.localLoot || 'não informado'}\n` +
            `📦 **Baú:** ${textoStatusBau(grupo)}\n\n` +
            '*Os pontos de XP foram adicionados à conta de cada membro no banco de dados.*'
        );

    adicionarCampoLongo(embed, 'Checklist de Pagamentos — Sacolas', gerarLinhasSplitSacolas(grupo).join('\n') || 'Sem jogadores.');

    if (grupo.bau?.printUrl && urlImagemValida(grupo.bau.printUrl)) embed.setImage(grupo.bau.printUrl);

    if (grupo.bau?.status === 'comprado_interno' || grupo.bau?.status === 'vendido_leilao') {
        adicionarCampoLongo(embed, 'Distribuição do Baú', gerarLinhasSplitValor(grupo.bau.splitFinal).join('\n') || 'Sem distribuição registrada.');
    } else if (grupo.bau?.status === 'em_leilao' && grupo.bau.leilao) {
        const leilao = grupo.bau.leilao;
        embed.addFields({
            name: '[ ⏳ PENDENTE - EM LEILÃO ]',
            value: [
                `Canal: ${leilao.channelId ? `<#${leilao.channelId}>` : 'não localizado'}`,
                `Desconto aplicado: **${formatarPercentual(grupo.bau.descontoPercentual)}**`,
                `Lance inicial: **${formatarPrata(leilao.lanceInicial)}**`,
                leilao.maiorLance ? `Maior lance: **${formatarPrata(leilao.maiorLance)}** por <@${leilao.maiorLicitanteId}>` : 'Maior lance: nenhum lance recebido'
            ].join('\n'),
            inline: false
        });
    }

    if (split?.falhasDmParticipantes?.length > 0) {
        adicionarCampoLongo(embed, '⚠️ DMs não entregues aos participantes', split.falhasDmParticipantes.map(id => `<@${id}>`).join(', '));
    }

    return embed;
}

function gerarComponentesAberturaPainelPosSplit(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dash_payment_panel_${evento.id}_${idx}`).setLabel('Painel de Pagamentos').setEmoji('✅').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dash_bau_panel_${evento.id}_${idx}`).setLabel('Gerenciar Baú').setEmoji('📦').setStyle(ButtonStyle.Secondary)
        )
    ];
}

function gerarPainelPagamentosGrupo(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const resultados = grupo?.splitSacolas?.resultados || [];
    if (!grupo?.splitSacolas) return { content: '❌ O split de sacolas ainda não foi fechado para este grupo.', components: [], ephemeral: true };

    const linhas = gerarLinhasSplitSacolas(grupo);
    const pendentes = resultados.filter(resultado => !resultado.pago).length;
    const componentes = [];
    const botoes = [];

    botoes.push(
        new ButtonBuilder()
            .setCustomId(`dash_pay_all_sacola_${evento.id}_${idx}`)
            .setLabel('Pay All')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
            .setDisabled(pendentes === 0)
    );

    resultados.slice(0, 24).forEach((resultado, index) => {
        botoes.push(
            new ButtonBuilder()
                .setCustomId(`dash_pay_sacola_${evento.id}_${idx}_${resultado.userId}`)
                .setLabel(`${resultado.pago ? 'Pago' : 'Pagar'} #${index + 1}`)
                .setStyle(resultado.pago ? ButtonStyle.Secondary : ButtonStyle.Primary)
                .setDisabled(Boolean(resultado.pago))
        );
    });

    for (let i = 0; i < botoes.length && componentes.length < 5; i += 5) {
        componentes.push(new ActionRowBuilder().addComponents(botoes.slice(i, i + 5)));
    }

    const avisoLimite = resultados.length > 24 ? '\n⚠️ A lista tem mais de 24 membros; use **Pay All** para concluir todos de uma vez.' : '';
    const resumo = dividirTextoDiscord(linhas.join('\n') || 'Sem jogadores.', 1800)[0];
    return {
        content: `👑 **Checklist de Pagamentos — Grupo ${idx + 1}**\nPendentes: **${pendentes}**\n\n${resumo}${avisoLimite}`,
        components: componentes,
        ephemeral: true
    };
}

function gerarPainelBauGrupo(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    if (!grupo?.splitSacolas) return { content: '❌ Feche primeiro o split de sacolas do grupo.', components: [], ephemeral: true };
    const bau = grupo.bau || criarEstadoBauPadrao();
    const linhas = [
        `📦 **Baú — Grupo ${idx + 1}**`,
        `Status: ${textoStatusBau(grupo)}`,
        `Local do loot: **${bau.localLoot || 'não informado'}**`,
        `Desconto do leilão: **${formatarPercentual(bau.descontoPercentual)}**`,
        `Valor bruto: **${formatarPrata(bau.valorBruto)}**`,
        `Reparo: **${formatarPrata(bau.valorReparo)}**`,
        `Líquido estimado: **${formatarPrata(bau.valorLiquido)}**`
    ];
    if (bau.printUrl) linhas.push(`Print: ${bau.printUrl}`);

    if (bau.status === 'nao_informado' || bau.status === 'sem_bau') {
        return {
            content: `${linhas.join('\n')}\n\nEnvie o print do baú neste chat e use **Usar Último Print**, ou cole o link no formulário manual.`,
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`dash_bau_ultimo_${evento.id}_${idx}`).setLabel('Usar Último Print').setEmoji('🖼️').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`dash_bau_informar_${evento.id}_${idx}`).setLabel('Informar Dados').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`dash_bau_sem_${evento.id}_${idx}`).setLabel('Sem Baú').setEmoji('🚫').setStyle(ButtonStyle.Secondary)
                )
            ],
            ephemeral: true
        };
    }

    if (bau.status === 'aguardando_decisao') {
        return {
            content: `${linhas.join('\n')}\n\nEscolha como o baú será tratado.`,
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`dash_bau_buyout_${evento.id}_${idx}`).setLabel('Compra Interna').setEmoji('🤝').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`dash_bau_leilao_${evento.id}_${idx}`).setLabel('Enviar para Leilão').setEmoji('🏷️').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`dash_bau_informar_${evento.id}_${idx}`).setLabel('Corrigir Dados').setEmoji('✏️').setStyle(ButtonStyle.Secondary)
                )
            ],
            ephemeral: true
        };
    }

    return { content: linhas.join('\n'), components: [], ephemeral: true };
}

function criarModalBau(idEvento, indexGrupo, printUrl = '') {
    const inputPrint = new TextInputBuilder()
        .setCustomId('bau_print_url')
        .setLabel('URL do print do baú')
        .setPlaceholder('Cole o link do anexo/imagem do Discord')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);
    if (printUrl) inputPrint.setValue(limitarTexto(printUrl, 4000));

    const modal = new ModalBuilder().setCustomId(`modal_bau_${idEvento}_${indexGrupo}`).setTitle('Dados do Baú');
    modal.addComponents(
        new ActionRowBuilder().addComponents(inputPrint),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bau_local').setLabel('Local onde o loot está').setPlaceholder('Ex: Brecilia, Thetford, Martlock...').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bau_valor_bruto').setLabel('Valor total estimado do loot').setPlaceholder('Ex: 5.500.000').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bau_valor_reparo').setLabel('Valor estimado do reparo').setPlaceholder('Ex: 350.000').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bau_desconto').setLabel('Desconto para lance inicial (%)').setPlaceholder('Ex: 20 para 20%').setStyle(TextInputStyle.Short).setRequired(true))
    );
    return modal;
}

function criarModalBuyoutBau(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const bau = evento.grupos[idx].bau || criarEstadoBauPadrao();
    const inputValor = new TextInputBuilder()
        .setCustomId('bau_valor_pago')
        .setLabel('Valor pago pelo baú')
        .setPlaceholder('Ex: 4.000.000')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    if (bau.valorLiquido > 0) inputValor.setValue(String(bau.valorLiquido));

    const modal = new ModalBuilder().setCustomId(`modal_bau_buyout_${evento.id}_${idx}`).setTitle('Compra Interna do Baú');
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bau_comprador').setLabel('Comprador (menção ou ID)').setPlaceholder('@Membro ou ID do membro da PT').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(inputValor)
    );
    return modal;
}

async function buscarUltimoPrintBau(channel, userId) {
    const mensagens = await channel.messages.fetch({ limit: 25 }).catch(() => null);
    if (!mensagens) return null;
    for (const mensagem of mensagens.values()) {
        if (mensagem.author?.id !== userId) continue;
        const anexo = mensagem.attachments.find(attachment => {
            const nome = attachment.name || attachment.url || '';
            return String(attachment.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(nome);
        });
        if (anexo?.url) return anexo.url;
    }
    return null;
}

function extrairUserIdTexto(texto) {
    return String(texto || '').match(/\d{15,25}/)?.[0] || null;
}

function calcularLanceInicial(valorLiquido, descontoPercentual = 20) {
    const desconto = parsePercentualDesconto(descontoPercentual, 20);
    return Math.floor(Math.max(0, Number(valorLiquido) || 0) * ((100 - desconto) / 100));
}

function gerarEmbedLeilao(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const bau = grupo.bau || criarEstadoBauPadrao();
    const leilao = bau.leilao || {};
    const maiorLanceTexto = leilao.maiorLance ? `**${formatarPrata(leilao.maiorLance)}** por <@${leilao.maiorLicitanteId}>` : '*Nenhum lance recebido ainda.*';
    const embed = new EmbedBuilder()
        .setTitle(`🏷️ LEILÃO DE LOOT — ${evento.nome} | Grupo ${idx + 1}`)
        .setColor(bau.status === 'vendido_leilao' ? '#2ecc71' : '#3498db')
        .setDescription('Use o botão **Dar Lance** para registrar uma oferta. O painel será atualizado automaticamente com o maior lance.')
        .addFields(
            { name: 'Local do loot', value: bau.localLoot || 'não informado', inline: false },
            { name: 'Valor bruto dos itens', value: formatarPrata(bau.valorBruto), inline: true },
            { name: 'Reparo estimado', value: formatarPrata(bau.valorReparo), inline: true },
            { name: 'Valor líquido estimado', value: formatarPrata(bau.valorLiquido), inline: true },
            { name: `Lance inicial (-${formatarPercentual(bau.descontoPercentual)} do líquido)`, value: `**${formatarPrata(leilao.lanceInicial || calcularLanceInicial(bau.valorLiquido, bau.descontoPercentual))}**`, inline: false },
            { name: 'Maior lance atual', value: maiorLanceTexto, inline: false }
        )
        .setFooter({ text: bau.status === 'vendido_leilao' ? 'Leilão encerrado.' : 'Lances abaixo do mínimo ou do maior lance atual serão recusados.' });
    if (bau.printUrl && urlImagemValida(bau.printUrl)) embed.setImage(bau.printUrl);
    return embed;
}

function gerarComponentesLeilao(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const bau = grupo.bau || criarEstadoBauPadrao();
    const encerrado = bau.status === 'vendido_leilao';
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`auction_bid_${evento.id}_${idx}`).setLabel('Dar Lance').setEmoji('💰').setStyle(ButtonStyle.Primary).setDisabled(encerrado),
            new ButtonBuilder().setCustomId(`auction_close_${evento.id}_${idx}`).setLabel('Encerrar Leilão').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(encerrado || !bau.leilao?.maiorLance)
        )
    ];
}

async function atualizarRegistroEvento(guild, evento, indexGrupo) {
    const grupo = evento?.grupos?.[normalizarIndexGrupo(indexGrupo)];
    if (!guild || !grupo?.splitSacolas) return;
    const payload = { embeds: [gerarEmbedRegistroEvento(evento, indexGrupo)] };

    if (grupo.splitSacolas.registroChannelId && grupo.splitSacolas.registroMessageId) {
        const canalRegistro = guild.channels.cache.get(grupo.splitSacolas.registroChannelId) || await guild.channels.fetch(grupo.splitSacolas.registroChannelId).catch(() => null);
        const msgRegistro = canalRegistro?.messages ? await canalRegistro.messages.fetch(grupo.splitSacolas.registroMessageId).catch(() => null) : null;
        if (msgRegistro) await msgRegistro.edit(payload).catch(() => null);
    }

    if (grupo.splitSacolas.relatorioChannelId && grupo.splitSacolas.relatorioMessageId) {
        const canalRelatorio = guild.channels.cache.get(grupo.splitSacolas.relatorioChannelId) || await guild.channels.fetch(grupo.splitSacolas.relatorioChannelId).catch(() => null);
        const msgRelatorio = canalRelatorio?.messages ? await canalRelatorio.messages.fetch(grupo.splitSacolas.relatorioMessageId).catch(() => null) : null;
        if (msgRelatorio) await msgRelatorio.edit(payload).catch(() => null);
    }
}

function obterLeiloesAtivosUsuario(guildId, userId) {
    const leiloes = [];
    for (const [, evento] of eventosAtivos) {
        if (evento.guildId !== guildId) continue;
        evento.grupos.forEach((grupo, index) => {
            if (grupo?.bau?.status !== 'em_leilao') return;
            if (!grupo.participantes?.some(p => p.id === userId)) return;
            leiloes.push({
                eventoNome: evento.nome,
                grupo: index + 1,
                localLoot: grupo.bau.localLoot || 'não informado',
                lanceAtual: grupo.bau.leilao?.maiorLance || grupo.bau.leilao?.lanceInicial || 0,
                channelId: grupo.bau.leilao?.channelId || null
            });
        });
    }
    return leiloes;
}

function linhasLancamentosSaldo(lancamentos, limite = 8) {
    const lista = lancamentos.slice(-limite).reverse();
    return lista.map(item => `• **${formatarPrata(item.valor)}** — ${item.descricao}`);
}

function gerarEmbedSaldo(guildId, userId) {
    const saldo = obterSaldoMembro(guildId, userId);
    const disponiveis = saldo.lancamentos.filter(item => item.status === 'disponivel' && item.valor > 0);
    const solicitados = saldo.lancamentos.filter(item => item.status === 'solicitado' && item.valor > 0);
    const pagos = saldo.lancamentos.filter(item => item.status === 'pago' && item.valor > 0);
    const leiloes = obterLeiloesAtivosUsuario(guildId, userId);
    const totalDisponivel = disponiveis.reduce((acc, item) => acc + item.valor, 0);
    const totalSolicitado = solicitados.reduce((acc, item) => acc + item.valor, 0);

    const embed = new EmbedBuilder()
        .setTitle('💼 Seu saldo de splits')
        .setColor(totalDisponivel > 0 ? '#2ecc71' : '#95a5a6')
        .setDescription(`Saldo disponível para resgate: **${formatarPrata(totalDisponivel)}**\nResgates aguardando pagamento: **${formatarPrata(totalSolicitado)}**`);

    adicionarCampoLongo(embed, 'Disponível para resgate', linhasLancamentosSaldo(disponiveis).join('\n') || 'Nada disponível no momento.');
    adicionarCampoLongo(embed, 'Pendente de pagamento', linhasLancamentosSaldo(solicitados).join('\n') || 'Nenhum resgate solicitado.');
    adicionarCampoLongo(embed, 'Em leilão', leiloes.map(item => `• ${item.eventoNome} | Grupo ${item.grupo} | ${item.localLoot} | ${item.channelId ? `<#${item.channelId}>` : 'canal não localizado'} | referência: **${formatarPrata(item.lanceAtual)}**`).join('\n') || 'Nenhum baú seu está em leilão agora.');
    adicionarCampoLongo(embed, 'Últimos pagos', linhasLancamentosSaldo(pagos, 5).join('\n') || 'Nenhum pagamento registrado.');
    return embed;
}

function gerarComponentesSaldo(guildId, userId) {
    const saldo = obterSaldoMembro(guildId, userId);
    const totalDisponivel = saldo.lancamentos
        .filter(item => item.status === 'disponivel' && item.valor > 0)
        .reduce((acc, item) => acc + item.valor, 0);
    return totalDisponivel > 0
        ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`saldo_resgate_${guildId}_${userId}`).setLabel('Solicitar Resgate').setEmoji('💸').setStyle(ButtonStyle.Success))]
        : [];
}

async function enviarDmResponsaveisLeilao(guild, configGuild, payload) {
    if (!guild || !configGuild?.cargoLeilaoId) return 0;
    const membros = guild.members.cache.filter(membro => membro.roles.cache.has(configGuild.cargoLeilaoId) && !membro.user.bot);

    let enviados = 0;
    for (const membro of membros.values()) {
        const enviado = await enviarDmUsuario(membro.id, payload);
        if (enviado) enviados++;
    }
    return enviados;
}

async function solicitarResgateSaldo(interaction, guildId, userId) {
    if (interaction.user.id !== userId) {
        return interaction.reply({ content: '❌ Você só pode solicitar resgate do seu próprio saldo.', ephemeral: true });
    }

    const guild = interaction.guild || client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const configGuild = configuracoesPorGuild.get(guildId);
    if (!configGuild?.cargoLeilaoId) {
        return interaction.reply({ content: '❌ O cargo responsável por leilões/resgates ainda não foi configurado em /configuracoes.', ephemeral: true });
    }

    const saldo = obterSaldoMembro(guildId, userId);
    const disponiveis = saldo.lancamentos.filter(item => item.status === 'disponivel' && item.valor > 0);
    if (disponiveis.length === 0) {
        return interaction.update({ embeds: [gerarEmbedSaldo(guildId, userId)], components: gerarComponentesSaldo(guildId, userId) });
    }
    await interaction.deferUpdate();

    const resgateId = Date.now().toString();
    const valorTotal = disponiveis.reduce((acc, item) => acc + item.valor, 0);
    disponiveis.forEach(item => {
        item.status = 'solicitado';
        item.solicitadoEmMs = Date.now();
        item.resgateId = resgateId;
    });
    saldo.resgates.push({
        id: resgateId,
        valorTotal,
        status: 'solicitado',
        solicitadoEmMs: Date.now(),
        pagoEmMs: null,
        pagoPorId: null,
        lancamentoIds: disponiveis.map(item => item.id)
    });
    salvarDados();

    const embedPedido = new EmbedBuilder()
        .setTitle('💸 Solicitação de resgate')
        .setColor('#f1c40f')
        .setDescription(`<@${userId}> solicitou resgate de **${formatarPrata(valorTotal)}**.`)
        .addFields({ name: 'Itens incluídos', value: dividirTextoDiscord(disponiveis.map(item => `• ${item.descricao}: **${formatarPrata(item.valor)}**`).join('\n'), 1024)[0] })
        .setFooter({ text: `Resgate ID: ${resgateId}` });
    const componentes = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`saldo_pagar_${guildId}_${userId}_${resgateId}`).setLabel('Marcar como Pago').setEmoji('✅').setStyle(ButtonStyle.Success))];

    if (interaction.channel?.send) {
        await interaction.channel.send({
            content: `<@&${configGuild.cargoLeilaoId}> novo resgate solicitado por <@${userId}>.`,
            embeds: [embedPedido],
            components: componentes,
            allowedMentions: { roles: [configGuild.cargoLeilaoId], users: [userId] }
        }).catch(() => null);
    }

    const dmsEnviadas = await enviarDmResponsaveisLeilao(guild, configGuild, { embeds: [embedPedido], components: componentes });
    await enviarDmUsuario(userId, { embeds: [new EmbedBuilder().setTitle('✅ Resgate solicitado').setColor('#2ecc71').setDescription(`Seu pedido de **${formatarPrata(valorTotal)}** foi enviado para o cargo responsável.`)] });

    return interaction.editReply({
        content: `✅ Resgate solicitado. DMs enviadas aos responsáveis: **${dmsEnviadas}**.`,
        embeds: [gerarEmbedSaldo(guildId, userId)],
        components: gerarComponentesSaldo(guildId, userId)
    });
}

async function marcarResgateComoPago(interaction, guildId, userId, resgateId) {
    const guild = interaction.guild || client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const podeOperar = await usuarioPodeOperarLeilao(interaction, guildId);
    if (!podeOperar) return interaction.reply({ content: '❌ Apenas o cargo responsável por leilões/resgates pode marcar este resgate como pago.', ephemeral: true });

    const saldo = obterSaldoMembro(guildId, userId);
    const resgate = saldo.resgates.find(item => item.id === resgateId);
    if (!resgate) return interaction.reply({ content: '❌ Resgate não encontrado.', ephemeral: true });
    if (resgate.status === 'pago') return interaction.reply({ content: '✅ Este resgate já estava marcado como pago.', ephemeral: true });
    await interaction.deferUpdate();

    resgate.status = 'pago';
    resgate.pagoEmMs = Date.now();
    resgate.pagoPorId = interaction.user.id;

    const eventosParaAtualizar = new Set();
    saldo.lancamentos.forEach(lancamento => {
        if (lancamento.resgateId !== resgateId) return;
        lancamento.status = 'pago';
        lancamento.pagoEmMs = Date.now();
        lancamento.pagoPorId = interaction.user.id;
        if (lancamento.tipo === 'sacolas' && lancamento.eventoId) {
            const evento = eventosAtivos.get(lancamento.eventoId);
            const grupo = evento?.grupos?.[normalizarIndexGrupo(lancamento.grupoIndex)];
            const resultado = grupo?.splitSacolas?.resultados?.find(item => item.userId === userId);
            if (resultado) {
                resultado.pago = true;
                resultado.pagoEmMs = Date.now();
                resultado.pagoPorId = interaction.user.id;
                eventosParaAtualizar.add(`${lancamento.eventoId}_${normalizarIndexGrupo(lancamento.grupoIndex)}`);
            }
        }
    });

    salvarDados();
    for (const chave of eventosParaAtualizar) {
        const [eventoId, grupoIndex] = chave.split('_');
        const evento = eventosAtivos.get(eventoId);
        if (evento && guild) await atualizarRegistroEvento(guild, evento, grupoIndex);
    }

    await enviarDmUsuario(userId, { embeds: [new EmbedBuilder().setTitle('✅ Resgate pago').setColor('#2ecc71').setDescription(`Seu resgate de **${formatarPrata(resgate.valorTotal)}** foi marcado como pago por <@${interaction.user.id}>.`)] });
    const resposta = { content: `✅ Resgate de <@${userId}> marcado como pago: **${formatarPrata(resgate.valorTotal)}**.`, components: [] };
    return interaction.editReply(resposta);
}

function gerarMenuRoles(idEvento, indexGrupo) {
    const evento = eventosAtivos.get(idEvento); const grupo = evento?.grupos[indexGrupo]; const options = [];
    if (!evento || !grupo || grupo.fechado) {
        options.push({ label: 'Evento indisponível', value: 'UNAVAILABLE' });
        return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_role_${idEvento}_${indexGrupo}`).setPlaceholder('Escolha sua função...').addOptions(options));
    }
    const verificarVaga = (label, roleKey) => { if (evento.composicao[roleKey].length > 0 && grupo.participantes.filter(p => p.role === roleKey).length < evento.composicao[roleKey].length) options.push({ label: label, value: roleParaSlug(roleKey) }); };
    verificarVaga('🛡️ Tank', 'TANK'); verificarVaga('💚 Healer', 'HEALER'); verificarVaga('🔮 Suporte', 'SUPORTE'); verificarVaga('⚔️ DPS Melee', 'DPS'); verificarVaga('🏹 DPS Ranger', 'DPS RANGER');
    if (options.length === 0) options.push({ label: 'Grupo Totalmente Lotado', value: 'FULL' });
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_role_${idEvento}_${indexGrupo}`).setPlaceholder('Escolha sua função...').addOptions(options));
}

function gerarMenuArmas(idEvento, indexGrupo, role) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const roleSlug = roleParaSlug(role);
    const evento = eventosAtivos.get(idEvento); const grupo = evento?.grupos[idx];
    if (!evento || !grupo || grupo.fechado || !evento.composicao[role]) {
        return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_weapon_${idEvento}_${idx}_${roleSlug}`).setPlaceholder('Escolha sua arma...').addOptions([{ label: 'Evento indisponível', value: 'UNAVAILABLE' }]));
    }
    const disponiveis = getAvailableWeapons(evento.composicao[role], grupo.participantes.filter(p => p.role === role));
    const contagem = {}; disponiveis.forEach(arma => contagem[arma] = (contagem[arma] || 0) + 1);
    const options = Object.keys(contagem).slice(0, MAX_OPCOES_MENU).map(arma => ({ label: limitarTexto(`${arma} (${contagem[arma]} vaga${contagem[arma] > 1 ? 's' : ''})`), value: limitarTexto(arma) }));
    if (options.length === 0) options.push({ label: 'Nenhuma arma disponível', value: 'UNAVAILABLE' });
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_weapon_${idEvento}_${idx}_${roleSlug}`).setPlaceholder('Escolha sua arma...').addOptions(options));
}

async function abrirSalaGrupo(guild, evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const permissionOverwritesVoz = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }];
    const permissionOverwritesTexto = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }];

    for (const p of grupo.participantes) {
        permissionOverwritesVoz.push({ id: p.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
        permissionOverwritesTexto.push({ id: p.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        p.lastStartMs = null; p.isPaused = false;
    }

    const categoriaValida = evento.categoriaId && guild.channels.cache.get(evento.categoriaId) && guild.channels.cache.get(evento.categoriaId).type === ChannelType.GuildCategory;

    let canalVoz = await guild.channels.create({ name: `Sala Grupo ${idx + 1} - ${evento.nome}`, type: ChannelType.GuildVoice, parent: categoriaValida ? evento.categoriaId : undefined, permissionOverwrites: permissionOverwritesVoz });
    grupo.canalVozId = canalVoz.id;

    const slugEvento = criarSlug(evento.nome);
    let canalTexto = await guild.channels.create({ name: `chat-grupo-${idx + 1}-${slugEvento}`.slice(0, 95), type: ChannelType.GuildText, parent: categoriaValida ? evento.categoriaId : undefined, permissionOverwrites: permissionOverwritesTexto });
    grupo.canalTextoId = canalTexto.id;

    const dashMsg = await canalTexto.send(gerarDashboardGrupo(evento, idx));
    grupo.dashboardMsgId = dashMsg.id;
    salvarDados();
    return { canalVoz, canalTexto };
}

async function enviarDmUsuario(userId, payload) {
    try {
        const user = await client.users.fetch(userId);
        await user.send(payload);
        return true;
    } catch (err) {
        console.log(`Não foi possível enviar DM para o ID ${userId}: ${err.message}`);
        return false;
    }
}

function gerarEmbedRegistroPreRaid(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const embed = new EmbedBuilder()
        .setTitle(`📋 Registro do Grupo ${idx + 1}: ${evento.nome}`)
        .setColor('#9b59b6')
        .setDescription(`Resumo atual da composição para o bloco das **${grupo.horario}**.\n${textoRequisitosBuild(evento, configuracoesPorGuild.get(evento.guildId))}`);

    const participantesTexto = grupo.participantes.length
        ? grupo.participantes.map(p => `<@${p.id}> — **${p.role}** [${p.arma}]`).join('\n')
        : '*Nenhum participante registrado até agora.*';

    const roles = [
        ['TANK', '🛡️', 'TANK'],
        ['HEALER', '💚', 'HEALER'],
        ['SUPORTE', '🔮', 'SUPORTE'],
        ['DPS', '⚔️', 'DPS MELEE'],
        ['DPS RANGER', '🏹', 'DPS RANGER']
    ];

    const vagasTexto = roles.map(([roleKey, emoji, label]) => {
        const exigidas = evento.composicao[roleKey] || [];
        if (exigidas.length === 0) return '';
        const membros = grupo.participantes.filter(p => p.role === roleKey);
        const livres = getAvailableWeapons(exigidas, membros);
        if (livres.length === 0) return `${emoji} **${label}:** ✅ preenchido`;
        return `${emoji} **${label}:** ${livres.map(arma => `\`${arma}\``).join(', ')}`;
    }).filter(Boolean).join('\n') || '✅ Todas as vagas configuradas foram preenchidas.';

    adicionarCampoLongo(embed, '👥 Participantes registrados', participantesTexto);
    adicionarCampoLongo(embed, '🧩 Vagas ainda abertas', vagasTexto);
    return embed;
}

function deveDispararAlertaGrupo(grupo) {
    if (!grupo?.inicioPrevistoMs || grupo.notificado) return false;
    return Date.now() >= grupo.inicioPrevistoMs - (MINUTOS_ABERTURA_SALA * 60 * 1000);
}

async function notificarPreRaidGrupo(guild, evento, indexGrupo) {
    const grupo = evento.grupos[indexGrupo];
    if (!grupo || grupo.notificado) return [];

    const destinatariosParticipantes = new Set(grupo.participantes.map(p => p.id).filter(id => id !== evento.lider));

    const embed = new EmbedBuilder()
        .setTitle(`⏰ Raid em ${MINUTOS_ABERTURA_SALA} minutos: ${evento.nome}`)
        .setColor('#3498db')
        .setDescription(`O **Grupo ${normalizarIndexGrupo(indexGrupo) + 1}** começa às **${grupo.horario}**.\nAs salas já foram abertas para os participantes registrados.`)
        .addFields(
            { name: '📚 Build no fórum', value: evento.tituloBuildForum ? `\`${evento.tituloBuildForum}\`` : '—', inline: false },
            { name: '⚙️ Tier', value: `\`${valorCampoExibicao(evento.tierEquipamento)}\``, inline: true },
            { name: '📊 IP', value: `\`${valorCampoExibicao(evento.ipBuild)}\``, inline: true },
            { name: '🎧 Sala de Voz', value: grupo.canalVozId ? `<#${grupo.canalVozId}>` : '*Ainda não criada*', inline: true },
            { name: '💬 Chat da PT', value: grupo.canalTextoId ? `<#${grupo.canalTextoId}>` : '*Ainda não criado*', inline: true },
            { name: '👥 Participantes', value: `${grupo.participantes.length}/${evento.totalVagas}`, inline: true }
        )
        .setFooter({ text: 'Entre na sala de voz para o cronômetro começar a contar seu tempo ativo.' });

    const falhas = [];
    for (const userId of destinatariosParticipantes) {
        const enviado = await enviarDmUsuario(userId, { embeds: [embed] });
        if (!enviado) falhas.push(userId);
    }

    const embedRegistroLider = gerarEmbedRegistroPreRaid(evento, indexGrupo);
    const dmLiderEnviada = await enviarDmUsuario(evento.lider, { embeds: [embed, embedRegistroLider] });
    if (!dmLiderEnviada) falhas.push(evento.lider);

    grupo.notificado = true;
    salvarDados();
    if (falhas.length > 0) console.log(`Falha ao enviar alerta pré-raid para: ${falhas.join(', ')}`);
    return falhas;
}

async function excluirCanalRegistro(registro) {
    try {
        if (registro.apagarEmMs && Date.now() < registro.apagarEmMs) {
            agendarExclusaoCanalRegistro(registro);
            return;
        }
        const guild = client.guilds.cache.get(registro.guildId) || await client.guilds.fetch(registro.guildId).catch(() => null);
        const canal = guild ? (guild.channels.cache.get(registro.channelId) || await guild.channels.fetch(registro.channelId).catch(() => null)) : null;
        if (canal) await canal.delete('Registro temporário expirado.').catch(() => null);
    } catch (error) {
        console.error('Erro ao excluir canal temporário de registro:', error);
    } finally {
        registrosCanais.delete(registro.channelId);
        salvarDados();
    }
}

function agendarExclusaoCanalRegistro(registro) {
    const delay = registro.apagarEmMs - Date.now();
    const executar = () => excluirCanalRegistro(registro).catch(() => null);
    if (delay <= 0) executar();
    else setTimeout(executar, Math.min(delay, 2147483647));
}

function agendarRegistrosSalvos() {
    for (const registro of registrosCanais.values()) agendarExclusaoCanalRegistro(registro);
}

async function estenderRetencaoRegistroLeilao(guild, grupo) {
    const channelId = grupo?.splitSacolas?.registroChannelId;
    if (!channelId) return false;
    const registro = registrosCanais.get(channelId);
    if (!registro) return false;
    registro.apagarEmMs = Math.max(registro.apagarEmMs || 0, Date.now() + TEMPO_RETENCAO_REGISTROS_LEILAO_MS);
    registro.retencaoEstendidaLeilao = true;
    const canal = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (canal?.setTopic) {
        await canal.setTopic(`Registro temporário estendido por leilão aberto. Apaga automaticamente em até ${DIAS_RETENCAO_REGISTROS_LEILAO} dias.`).catch(() => null);
    }
    salvarDados();
    agendarExclusaoCanalRegistro(registro);
    return true;
}

async function criarCanalRegistroSplit(guild, evento, indexGrupo, embedSplit, configGuild) {
    if (!configGuild?.categoriaRegistrosId) return { criado: false, motivo: 'categoria_nao_configurada' };

    const categoria = guild.channels.cache.get(configGuild.categoriaRegistrosId) || await guild.channels.fetch(configGuild.categoriaRegistrosId).catch(() => null);
    if (!categoria || categoria.type !== ChannelType.GuildCategory) return { criado: false, motivo: 'categoria_invalida' };

    const apagarEmMs = Date.now() + TEMPO_RETENCAO_REGISTROS_MS;
    const slugEvento = criarSlug(evento.nome);
    const nomeCanal = `registro-g${parseInt(indexGrupo, 10) + 1}-${slugEvento}`.slice(0, 95);
    const canalRegistro = await guild.channels.create({
        name: nomeCanal,
        type: ChannelType.GuildText,
        parent: categoria.id,
        topic: `Registro temporário do evento ${evento.nome}. Apaga automaticamente em ${DIAS_RETENCAO_REGISTROS} dias.`
    });

    const mensagemRegistro = await canalRegistro.send({
        content: `📌 Registro temporário do split. Este canal será apagado automaticamente em **${DIAS_RETENCAO_REGISTROS} dias**.`,
        embeds: [embedSplit]
    });

    const registro = {
        guildId: guild.id,
        channelId: canalRegistro.id,
        eventoId: evento.id,
        nomeEvento: evento.nome,
        grupo: parseInt(indexGrupo, 10) + 1,
        criadoEmMs: Date.now(),
        apagarEmMs
    };

    registrosCanais.set(canalRegistro.id, registro);
    salvarDados();
    agendarExclusaoCanalRegistro(registro);
    return { criado: true, canalId: canalRegistro.id, messageId: mensagemRegistro.id };
}

function gerarEmbedEventoEncerrado(userId, detalhe = 'Todas as salas vinculadas a este evento foram apagadas e os dados foram salvos.') {
    return new EmbedBuilder()
        .setTitle(`✅ EVENTO ENCERRADO DEFINITIVAMENTE`)
        .setColor('#7f8c8d')
        .setDescription(`Encerrado por <@${userId}>.\n${detalhe}`);
}

async function encerrarMensagemEventoSemMemoria(interaction, idEvento = null) {
    const idsCanais = new Set();
    interaction.message?.embeds?.forEach(embed => {
        const textos = [embed.description, ...(embed.fields || []).map(field => `${field.name}\n${field.value}`)].filter(Boolean);
        textos.forEach(texto => {
            const matches = String(texto).matchAll(/<#(\d+)>/g);
            for (const match of matches) idsCanais.add(match[1]);
        });
    });

    for (const channelId of idsCanais) {
        const canal = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (canal && canal.deletable) await canal.delete('Evento encerrado (mensagem antiga ou após reinício do bot).').catch(() => null);
    }

    if (idEvento) removerEventoPersistido(idEvento);

    const detalhe = idsCanais.size > 0
        ? `A mensagem foi encerrada e ${idsCanais.size} canal(is) vinculado(s) foram removidos quando possível.`
        : 'A mensagem foi encerrada e os botões foram removidos.';

    await interaction.update({ embeds: [gerarEmbedEventoEncerrado(interaction.user.id, detalhe)], components: [] });
}

function usuarioPodeEncerrarMensagemAntiga(interaction, idEvento = null) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) return true;
    const autorMensagem = interaction.message?.interactionMetadata?.user?.id || interaction.message?.interaction?.user?.id;
    if (autorMensagem && autorMensagem === interaction.user.id) return true;
    const descricao = interaction.message?.embeds?.[0]?.description || '';
    const liderId = descricao.match(/Líder:\*\*\s*<@!?(\d+)>/)?.[1];
    if (liderId && liderId === interaction.user.id) return true;
    if (idEvento) {
        const evento = obterEvento(idEvento, interaction);
        if (evento && (interaction.user.id === evento.lider || interaction.user.id === evento.criadoPorId)) return true;
    }
    return false;
}

function eventoTemLeilaoAberto(evento) {
    return Boolean(evento?.grupos?.some(grupo => grupo?.bau?.status === 'em_leilao'));
}

// ==========================================
// COMANDOS DE BARRA (SLASH COMMANDS)
// ==========================================
const comandoEvento = new SlashCommandBuilder()
    .setName('evento')
    .setDescription('Cria evento com Split, Tier/IP da build e XP por hora')
    .addStringOption(opt => opt.setName('nome').setDescription('Nome da Raid/Evento').setRequired(true))
    .addUserOption(opt => opt.setName('lider').setDescription('Líder do evento').setRequired(true))
    .addStringOption(opt => opt.setName('tier_equipamento').setDescription('Tier: 4.1-4.2 ou null se usar só IP').setRequired(true))
    .addStringOption(opt => opt.setName('ip_build').setDescription('IP: 1450 ou null se usar só Tier').setRequired(true))
    .addStringOption(opt => opt.setName('horarios').setDescription('Ex: 13:00, 14:00...').setRequired(true))
    .addStringOption(opt => opt.setName('titulo_build').setDescription('Título no fórum de builds. Ex: Baú Dourado - 01').setRequired(true))
    .addStringOption(opt => opt.setName('armas_tank').setDescription('Ex: Maça, Fura-Bruma3').setRequired(false))
    .addStringOption(opt => opt.setName('armas_healer').setDescription('Ex: Sagrado, Natureza2').setRequired(false))
    .addStringOption(opt => opt.setName('armas_suporte').setDescription('Ex: Chama-sombra').setRequired(false))
    .addStringOption(opt => opt.setName('armas_dps').setDescription('Ex: Espada, Machado2').setRequired(false))
    .addStringOption(opt => opt.setName('armas_ranger').setDescription('Ex: Arco*3, Cajado').setRequired(false));

const comandoConfiguracoes = new SlashCommandBuilder()
    .setName('configuracoes')
    .setDescription('Configura categoria dos canais e cargo permitido')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('categoria_canais').setDescription('Categoria').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .addRoleOption(opt => opt.setName('cargo_evento').setDescription('Cargo permitido').setRequired(true))
    .addChannelOption(opt => opt.setName('categoria_registros').setDescription('Categoria onde os relatórios finais temporários serão guardados').addChannelTypes(ChannelType.GuildCategory).setRequired(false))
    .addChannelOption(opt => opt.setName('categoria_leiloes').setDescription('Categoria onde os canais temporários de leilão serão criados').addChannelTypes(ChannelType.GuildCategory).setRequired(false))
    .addRoleOption(opt => opt.setName('cargo_leiloes').setDescription('Cargo responsável por vendas, leilões e resgates').setRequired(false))
    .addChannelOption(opt => opt.setName('canal_forum_builds').setDescription('Canal fórum das builds (Conteúdo - 01, Baú Dourado - 01...)').addChannelTypes(ChannelType.GuildForum).setRequired(false));

const comandoRanking = new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('Mostra o Top 10 membros com mais XP de atividade no mês');

const comandoSaldo = new SlashCommandBuilder()
    .setName('saldo')
    .setDescription('Consulta seus splits, leilões pendentes e saldo disponível para resgate');

const COMANDOS_SLASH_JSON = [
    comandoEvento.toJSON(),
    comandoConfiguracoes.toJSON(),
    comandoRanking.toJSON(),
    comandoSaldo.toJSON()
];

async function registrarComandosSlash(rest, guildIds = []) {
    const opcoesEvento = (comandoEvento.toJSON().options || []).map(opt => opt.name);
    console.log(`📋 Opções do /evento (${opcoesEvento.length}): ${opcoesEvento.join(', ')}`);

    if (!opcoesEvento.includes('tier_equipamento') || !opcoesEvento.includes('ip_build') || !opcoesEvento.includes('titulo_build')) {
        throw new Error('Definição do comando /evento inválida: faltam tier_equipamento, ip_build ou titulo_build');
    }

    const idsServidores = new Set(guildIds);
    if (GUILD_ID) idsServidores.add(GUILD_ID);

    for (const guildId of idsServidores) {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: COMANDOS_SLASH_JSON });
        console.log(`✅ Comandos do servidor ${guildId} atualizados (Tier e IP visíveis agora)`);
    }

    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: COMANDOS_SLASH_JSON });
    console.log(idsServidores.size > 0
        ? '✅ Comandos globais sincronizados'
        : '⚠️ Defina GUILD_ID no .env ou adicione o bot a um servidor para atualização imediata');
}

// ==========================================
// INICIALIZAÇÃO E CRON JOB
// ==========================================
client.once('ready', async () => {
    console.log(`🤖 Bot online como ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await registrarComandosSlash(rest, [...client.guilds.cache.keys()]);
        console.log('✅ Sistema completo carregado!');
    } catch (error) {
        console.error('❌ Falha ao registrar comandos — Tier/IP não aparecerão no Discord:', error);
        process.exit(1);
    }

    agendarRegistrosSalvos();

    new cron.CronJob('* * * * *', async () => {
        for (const [idEvento, evento] of eventosAtivos) {
            const guild = client.guilds.cache.get(evento.guildId); if (!guild) continue;
            if (evento.encerradoDefinitivo) continue;
            for (let i = 0; i < evento.grupos.length; i++) {
                const grupo = evento.grupos[i];
                sincronizarCronometrosGrupo(guild, grupo);
                if (!grupo.inicioAtivoMs && grupo.inicioPrevistoMs && Date.now() >= grupo.inicioPrevistoMs) {
                    grupo.inicioAtivoMs = grupo.inicioPrevistoMs;
                    if (!evento.inicioAtivoMs) evento.inicioAtivoMs = grupo.inicioAtivoMs;
                    salvarDados();
                }
                if (deveAbrirSalaGrupo(grupo)) { try { await abrirSalaGrupo(guild, evento, i); } catch (e) { console.error('Erro ao abrir sala do grupo:', e); } }
                if (deveDispararAlertaGrupo(grupo) && grupo.canalVozId && grupo.canalTextoId) await notificarPreRaidGrupo(guild, evento, i);
                if (grupo.dashboardMsgId) await atualizarMsgDashboard(guild, evento, i);
            }
            await atualizarMensagemPrincipalEvento(guild, evento);
        }
    }).start();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const guild = newState.guild || oldState.guild;
        const userId = newState.id || oldState.id;
        if (!guild || !userId) return;

        for (const [, evento] of eventosAtivos) {
            if (evento.guildId !== guild.id) continue;

            for (let i = 0; i < evento.grupos.length; i++) {
                const grupo = evento.grupos[i];
                if (!grupo.canalVozId || grupo.fechado) continue;

                const entrouNaSala = newState.channelId === grupo.canalVozId;
                const saiuDaSala = oldState.channelId === grupo.canalVozId && newState.channelId !== grupo.canalVozId;
                if (!entrouNaSala && !saiuDaSala) continue;

                const participante = grupo.participantes.find(p => p.id === userId);
                if (!participante) continue;

                if (saiuDaSala || entrouNaSala) sincronizarParticipanteSeElegivel(guild, grupo, participante);

                await atualizarMsgDashboard(guild, evento, i);
                salvarDados();
            }
        }
    } catch (error) {
        console.error('Erro ao processar estado de voz:', error);
    }
});

// ==========================================
// INTERAÇÕES PRINCIPAIS E BOTÕES
// ==========================================
client.on('interactionCreate', async interaction => {
    try {

    // COMANDO /RANKING
    if (interaction.isChatInputCommand() && interaction.commandName === 'ranking') {
        const guildId = interaction.guild.id;
        const anoMesAtual = obterAnoMes();
        const prefixoXpMensal = `${guildId}_${anoMesAtual}_`;
        const listaRankeada = Array.from(xpMembros.entries())
            .filter(([chave]) => chave.startsWith(prefixoXpMensal))
            .map(([chave, xp]) => ({ userId: chave.slice(prefixoXpMensal.length), xp }))
            .sort((a, b) => b.xp - a.xp);

        const embedRank = new EmbedBuilder()
            .setTitle(`🏆 RANKING MENSAL DE ATIVIDADE — ${interaction.guild.name.toUpperCase()} (${anoMesAtual})`)
            .setColor('#f1c40f')
            .setDescription('Acompanhe o Top 10 membros que mais acumularam horas em Raids neste mês.\n*Lembrando: 1 hora de jogo ativa = 50 XP!* \n\n━━━━🎁 **PREMIAÇÃO TOP 3** 🎁━━━━');

        let corpoRanking = '';
        if (listaRankeada.length === 0) {
            corpoRanking = '*Nenhum jogador registrou XP neste servidor ainda.*';
        } else {
            listaRankeada.slice(0, 10).forEach((item, index) => {
                let medalha = `\`#${index + 1}\``;
                if (index === 0) medalha = '🥇 **TOP 1**';
                if (index === 1) medalha = '🥈 **TOP 2**';
                if (index === 2) medalha = '🥉 **TOP 3**';
                const horasEstimadas = (item.xp / 50).toFixed(1);
                corpoRanking += `${medalha} ➜ <@${item.userId}> — **${Math.floor(item.xp)} XP** *(~${horasEstimadas}h em Raid)*\n`;
            });
        }
        embedRank.addFields({ name: 'Placar de Líderes', value: corpoRanking });
        return interaction.reply({ embeds: [embedRank] });
    }

    // COMANDO /SALDO
    if (interaction.isChatInputCommand() && interaction.commandName === 'saldo') {
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        return interaction.reply({
            embeds: [gerarEmbedSaldo(guildId, userId)],
            components: gerarComponentesSaldo(guildId, userId),
            ephemeral: true
        });
    }

    // COMANDO /CONFIGURACOES
    if (interaction.isChatInputCommand() && interaction.commandName === 'configuracoes') {
        const categoria = interaction.options.getChannel('categoria_canais');
        const cargoEvento = interaction.options.getRole('cargo_evento');
        const categoriaRegistros = interaction.options.getChannel('categoria_registros');
        const categoriaLeiloes = interaction.options.getChannel('categoria_leiloes');
        const cargoLeiloes = interaction.options.getRole('cargo_leiloes');
        const canalForumBuilds = interaction.options.getChannel('canal_forum_builds');
        const configAtual = configuracoesPorGuild.get(interaction.guild.id) || {};
        configuracoesPorGuild.set(interaction.guild.id, {
            categoriaId: categoria.id,
            cargoEventoId: cargoEvento.id,
            categoriaRegistrosId: categoriaRegistros?.id || configAtual.categoriaRegistrosId || null,
            categoriaLeiloesId: categoriaLeiloes?.id || configAtual.categoriaLeiloesId || null,
            cargoLeilaoId: cargoLeiloes?.id || configAtual.cargoLeilaoId || null,
            canalForumBuildsId: canalForumBuilds?.id || configAtual.canalForumBuildsId || null,
            atualizadoPorId: interaction.user.id
        });
        salvarDados();
        const textoRegistros = categoriaRegistros
            ? `\n📁 Categoria de registros: <#${categoriaRegistros.id}>`
            : (configAtual.categoriaRegistrosId ? `\n📁 Categoria de registros mantida: <#${configAtual.categoriaRegistrosId}>` : '\n📁 Categoria de registros: não configurada');
        const textoForum = canalForumBuilds
            ? `\n📚 Fórum de builds: <#${canalForumBuilds.id}>`
            : (configAtual.canalForumBuildsId ? `\n📚 Fórum de builds mantido: <#${configAtual.canalForumBuildsId}>` : '\n📚 Fórum de builds: não configurado (configure para link na DM)');
        const textoLeiloes = categoriaLeiloes
            ? `\n🏷️ Categoria de leilões: <#${categoriaLeiloes.id}>`
            : (configAtual.categoriaLeiloesId ? `\n🏷️ Categoria de leilões mantida: <#${configAtual.categoriaLeiloesId}>` : '\n🏷️ Categoria de leilões: não configurada');
        const textoCargoLeiloes = cargoLeiloes
            ? `\n🧾 Cargo responsável por leilões/resgates: <@&${cargoLeiloes.id}>`
            : (configAtual.cargoLeilaoId ? `\n🧾 Cargo responsável por leilões/resgates mantido: <@&${configAtual.cargoLeilaoId}>` : '\n🧾 Cargo responsável por leilões/resgates: não configurado');
        return interaction.reply({ content: `✅ Configurações salvas!${textoRegistros}${textoLeiloes}${textoCargoLeiloes}${textoForum}`, ephemeral: true });
    }

    // COMANDO /EVENTO
    if (interaction.isChatInputCommand() && interaction.commandName === 'evento') {
        const configGuild = configuracoesPorGuild.get(interaction.guild.id);
        if (!configGuild) return interaction.reply({ content: '❌ Use /configuracoes primeiro.', ephemeral: true });
        if (!membroPodeCriarEvento(interaction, configGuild)) return interaction.reply({ content: '❌ Você não tem o cargo configurado para criar eventos.', ephemeral: true });

        const idEvento = Date.now().toString();
        const nome = interaction.options.getString('nome');
        const lider = interaction.options.getUser('lider');
        const tierEquipamento = campoEventoInformado(interaction.options.getString('tier_equipamento'));
        const ipBuild = normalizarIpBuild(interaction.options.getString('ip_build'));
        if (!tierEquipamento && !ipBuild) {
            return interaction.reply({
                content: '❌ Preencha **tier_equipamento** ou **ip_build** (pelo menos um). Para ignorar um campo, use `null` — ex: tier `4.1-4.2` e ip `null`, ou tier `null` e ip `1450`.',
                ephemeral: true
            });
        }
        const tituloBuildForum = normalizarTituloBuildForum(interaction.options.getString('titulo_build'));
        if (!tituloBuildForum) {
            return interaction.reply({
                content: '❌ Informe **titulo_build** com o nome exato do tópico no fórum (ex: `Baú Dourado - 01`).',
                ephemeral: true
            });
        }
        const horariosRaw = interaction.options.getString('horarios').split(',').map(h => h.trim()).filter(h => h !== '');
        const horariosInvalidos = horariosRaw.filter(h => !horarioValido(h));
        if (horariosInvalidos.length > 0) return interaction.reply({ content: `❌ Horário inválido: ${horariosInvalidos.join(', ')}. Use o formato HH:MM, por exemplo 13:00.`, ephemeral: true });

        const composicao = {
            'TANK': parseWeapons(interaction.options.getString('armas_tank')), 'HEALER': parseWeapons(interaction.options.getString('armas_healer')),
            'SUPORTE': parseWeapons(interaction.options.getString('armas_suporte')), 'DPS': parseWeapons(interaction.options.getString('armas_dps')),
            'DPS RANGER': parseWeapons(interaction.options.getString('armas_ranger'))
        };

        const totalVagas = Object.values(composicao).reduce((acc, arr) => acc + arr.length, 0);
        if (totalVagas === 0 || horariosRaw.length === 0) return interaction.reply({ content: '❌ Faltam parâmetros.', ephemeral: true });

        await interaction.deferReply();
        const numGrupos = Math.min(horariosRaw.length, 10); const grupos = []; const iniciosPrevistosGrupos = [];

        for (let i = 0; i < numGrupos; i++) {
            const minParaInicio = minutosAteHorario(horariosRaw[i]); const inicioMs = minParaInicio !== null ? Date.now() + (minParaInicio * 60 * 1000) : null;
            if (inicioMs) iniciosPrevistosGrupos.push(inicioMs);
            grupos.push({
                horario: horariosRaw[i], participantes: [], notificado: false, canalVozId: null, canalTextoId: null, dashboardMsgId: null,
                inicioPrevistoMs: inicioMs, inicioAtivoMs: null, lootTotal: 0, sacolaTotal: 0, splitSacolas: null, bau: criarEstadoBauPadrao(), fechado: false, fechadoEmMs: null,
                conteudoEstado: 'aguardando', conteudoTempoAcumuladoMs: 0, conteudoRodandoDesdeMs: null, conteudoInicioMs: null
            });
        }

        const novoEvento = {
            id: idEvento, nome, tierEquipamento, ipBuild, tituloBuildForum, lider: lider.id, criadoPorId: interaction.user.id, guildId: interaction.guild.id, categoriaId: configGuild.categoriaId,
            composicao, totalVagas, grupos, criadoEmMs: Date.now(), inicioPrevistoMs: iniciosPrevistosGrupos.length ? Math.min(...iniciosPrevistosGrupos) : null,
            inicioAtivoMs: null, mensagemPrincipalId: null, canalMensagemId: interaction.channel.id
        };

        eventosAtivos.set(idEvento, novoEvento);
        const mensagemPrincipal = await interaction.editReply(gerarInterface(novoEvento));
        novoEvento.mensagemPrincipalId = mensagemPrincipal.id;
        salvarDados();
    }

    // ESCOLHA DE GRUPO/ROLE/ARMA
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_group_')) {
        const idEvento = extrairIdEvento(interaction.customId, 'select_group_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        await interaction.reply({ content: `Você escolheu o **Grupo ${parseInt(interaction.values[0]) + 1}**. Classe:`, components: [gerarMenuRoles(idEvento, interaction.values[0])], ephemeral: true });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_role_')) {
        const partes = interaction.customId.split('_');
        const idEvento = partes[2];
        const indexGrupo = partes[3];
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!evento || !grupo || grupo.fechado) return interaction.update({ content: '❌ Este grupo não está disponível.', components: [] });
        if (interaction.values[0] === 'FULL') return interaction.update({ content: '❌ Lotado.', components: [] });
        if (interaction.values[0] === 'UNAVAILABLE') return interaction.update({ content: '❌ Evento indisponível.', components: [] });
        if (grupo.participantes.some(p => p.id === interaction.user.id)) return interaction.update({ content: '❌ Você já está inscrito neste grupo. Saia do grupo antes de trocar função ou arma.', components: [] });
        const role = slugParaRole(interaction.values[0]);
        await interaction.update({ content: `Classe **${role}**. Arma:`, components: [gerarMenuArmas(idEvento, indexGrupo, role)] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_weapon_')) {
        const resto = interaction.customId.slice('select_weapon_'.length);
        const partes = resto.split('_');
        const idEvento = partes[0];
        const indexGrupo = parseInt(partes[1], 10);
        const role = slugParaRole(partes.slice(2).join('_'));
        const arma = interaction.values[0];
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.update({ content: '❌ Inativo.', components: [] });
        const grupo = evento.grupos[indexGrupo];
        if (!grupo || grupo.fechado) return interaction.update({ content: '❌ Este grupo não está disponível.', components: [] });
        if (arma === 'UNAVAILABLE') return interaction.update({ content: '❌ Nenhuma arma disponível para esta função.', components: [] });
        if (grupo.participantes.some(p => p.id === interaction.user.id)) return interaction.update({ content: '❌ Você já está inscrito neste grupo.', components: [] });
        const armasDisponiveis = getAvailableWeapons(evento.composicao[role] || [], grupo.participantes.filter(p => p.role === role));
        if (!armasDisponiveis.includes(arma)) return interaction.update({ content: '❌ Essa vaga acabou de ser preenchida. Abra o menu novamente para ver as opções atuais.', components: [] });

        const novoParticipante = { id: interaction.user.id, role, arma, totalMs: 0, isPaused: false, lastStartMs: null };
        grupo.participantes.push(novoParticipante);

        if (grupo.canalVozId) await interaction.guild.channels.cache.get(grupo.canalVozId)?.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, Connect: true });
        if (grupo.canalTextoId) {
            await interaction.guild.channels.cache.get(grupo.canalTextoId)?.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        }
        sincronizarParticipanteSeElegivel(interaction.guild, grupo, novoParticipante);
        if (grupo.canalTextoId) await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
        await atualizarMensagemPrincipalEvento(interaction.guild, evento);
        salvarDados();
        const configGuildInscricao = configuracoesPorGuild.get(interaction.guild.id);
        const dmBuildEnviada = await enviarDmInstrucaoBuildParticipante(interaction.user.id, evento, configGuildInscricao, {
            grupo: indexGrupo + 1,
            horario: grupo.horario,
            role,
            arma
        });
        const avisoDm = dmBuildEnviada ? '' : '\n⚠️ Não foi possível enviar a DM com o título da build (verifique se suas DMs estão abertas).';
        await interaction.update({ content: `✅ Registrado!${avisoDm}`, components: [] });
    }

    // BOTÃO: INICIAR / PAUSAR / RETOMAR CONTEÚDO (LÍDER)
    if (interaction.isButton() && interaction.customId.startsWith('dash_conteudo_timer_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) {
            return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode controlar o timer do conteúdo.', ephemeral: true });
        }
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo já foi fechado.', ephemeral: true });

        const estadoAnterior = grupo.conteudoEstado || 'aguardando';
        const novoEstado = alternarConteudoGrupo(interaction.guild, grupo);
        salvarDados();
        await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);

        let mensagem = '✅ Estado do conteúdo atualizado.';
        if (novoEstado === 'rodando' && estadoAnterior === 'aguardando') {
            mensagem = '▶️ **Conteúdo iniciado!** O tempo só conta para quem está na sala de voz.';
        } else if (novoEstado === 'rodando') {
            mensagem = '▶️ **Conteúdo retomado!** Cronômetros ativos na sala de voz.';
        } else {
            mensagem = '⏸️ **Conteúdo pausado.** Todos os cronômetros foram parados.';
        }

        const painel = gerarPainelLiderGrupo(evento, indexGrupo);
        return interaction.reply({ content: mensagem, components: painel.components, ephemeral: true });
    }

    // BOTÃO: ABRIR PAINEL PRIVADO DO LÍDER
    if (interaction.isButton() && interaction.customId.startsWith('dash_leader_panel_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode abrir este painel.', ephemeral: true });
        return interaction.reply(gerarPainelLiderGrupo(evento, indexGrupo));
    }

    // BOTÃO: PAUSAR MEU TEMPO
    if (interaction.isButton() && interaction.customId.startsWith('dash_pause_self_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo não está disponível.', ephemeral: true });
        const participante = grupo.participantes.find(p => p.id === interaction.user.id);
        if (!participante) return interaction.reply({ content: '❌ Não está ativo.', ephemeral: true });
        togglePause(participante);
        sincronizarParticipanteSeElegivel(interaction.guild, grupo, participante);
        let complemento = '';
        if (!participante.isPaused && grupo.conteudoEstado !== 'rodando') complemento = '\nO tempo só contará quando o líder iniciar o conteúdo (Play).';
        else if (!participante.isPaused && !participante.lastStartMs) complemento = '\nEntre na sala de voz para o tempo voltar a contar.';
        await interaction.reply({ content: `✅ Seu cronômetro foi **${participante.isPaused ? 'Pausado' : 'Retomado'}**.${complemento}`, ephemeral: true });
        await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
        salvarDados();
    }

    // MENU: FORÇAR PAUSE (Líder)
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('dash_force_pause_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (interaction.user.id !== evento.lider && interaction.user.id !== evento.criadoPorId) return interaction.reply({ content: '❌ Negado.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        const targetId = interaction.values[0];
        if (!grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo não está disponível.', ephemeral: true });
        const participante = grupo.participantes.find(p => p.id === targetId);
        if (participante) {
            togglePause(participante);
            sincronizarParticipanteSeElegivel(interaction.guild, grupo, participante);
            await interaction.reply({ content: `✅ Cronômetro de <@${targetId}> foi **${participante.isPaused ? 'Pausado' : 'Retomado'}**.`, ephemeral: true });
            await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
            salvarDados();
        } else {
            await interaction.reply({ content: '❌ Participante não encontrado neste grupo.', ephemeral: true });
        }
    }

    // BOTÃO: ADICIONAR SACOLAS (MODAL)
    if (interaction.isButton() && interaction.customId.startsWith('dash_add_loot_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (interaction.user.id !== evento.lider && interaction.user.id !== evento.criadoPorId) return interaction.reply({ content: '❌ Apenas o Líder.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo já foi fechado ou não está disponível.', ephemeral: true });
        const modal = new ModalBuilder().setCustomId(`modal_sacolas_${idEvento}_${indexGrupo}`).setTitle('Lançamento de Sacolas');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val_sacola').setLabel('Valor de Sacolas/Prata Bruta').setPlaceholder('Ex: 1.000.000').setStyle(TextInputStyle.Short).setRequired(true))
        );
        await interaction.showModal(modal);
    }

    // RECEBIMENTO DO MODAL DE SACOLAS
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_sacolas_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!evento || !grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo já foi fechado ou não está disponível.', ephemeral: true });
        const addSacola = parseValorPrata(interaction.fields.getTextInputValue('val_sacola'));
        definirSacolaTotal(grupo, obterSacolaTotal(grupo) + addSacola);
        await interaction.reply({ content: `💰 **${formatarPrata(addSacola)}** adicionadas às sacolas. Total atual: **${formatarPrata(obterSacolaTotal(grupo))}**.`, ephemeral: true });
        await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
        salvarDados();
    }

    // BOTÃO: CALCULAR SPLIT DE SACOLAS, DM E XP
    if (interaction.isButton() && interaction.customId.startsWith('dash_calc_split_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (interaction.user.id !== evento.lider && interaction.user.id !== evento.criadoPorId) return interaction.reply({ content: '❌ Apenas o Líder.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo) return interaction.reply({ content: '❌ Grupo não encontrado.', ephemeral: true });
        if (grupo.fechado) return interaction.reply({ content: '❌ Este split já foi fechado.', ephemeral: true });

        finalizarConteudoGrupo(grupo);
        grupo.participantes.forEach(p => {
            pararCronometroParticipante(p);
            p.isPaused = true;
        });
        const totalMsGeral = grupo.participantes.reduce((acc, p) => acc + p.totalMs, 0);
        if (totalMsGeral === 0) {
            return interaction.reply({
                content: '❌ Tempo zerado. O líder deve **Iniciar Conteúdo (Play)** no painel e os participantes precisam estar na sala de voz durante o conteúdo.',
                ephemeral: true
            });
        }

        const duracaoTotalTexto = formatarDuracaoMs(tempoConteudoAtual(grupo));
        await interaction.reply({ content: '⏳ Processando o split de sacolas, adicionando XP e enviando os recibos na DM...', ephemeral: true });
        const falhasDmParticipantes = [];
        const totalSacolas = obterSacolaTotal(grupo);

        const resultadosSplit = await Promise.all(grupo.participantes.map(async (p) => {
            const fraction = p.totalMs / totalMsGeral;
            const ganho = Math.floor(totalSacolas * fraction);

            // CÁLCULO DE XP (50 XP por hora)
            const horasJogadas = p.totalMs / (1000 * 60 * 60);
            const xpGanho = horasJogadas * 50;

            const chaveBanco = obterChaveXp(interaction.guild.id, p.id);
            const xpAntigo = xpMembros.get(chaveBanco) || 0;
            xpMembros.set(chaveBanco, xpAntigo + xpGanho);

            const dmEmbed = new EmbedBuilder()
                .setTitle(`💰 Recibo de Raid & XP: ${evento.nome}`)
                .setColor('#f1c40f')
                .setDescription(`O split de **Sacolas/Prata Bruta** do **Grupo ${parseInt(indexGrupo) + 1}** foi realizado. O baú será tratado separadamente pelo líder.`)
                .addFields(
                    { name: '⚙️ Tier', value: `\`${valorCampoExibicao(evento.tierEquipamento)}\``, inline: true },
                    { name: '📊 IP', value: `\`${valorCampoExibicao(evento.ipBuild)}\``, inline: true },
                    { name: '⏱️ Tempo da Raid', value: duracaoTotalTexto, inline: true },
                    { name: '⌛ Seu Tempo Ativo', value: formatarDuracaoMs(p.totalMs), inline: true },
                    { name: '⚡ XP Adquirido', value: `**+${Math.floor(xpGanho)} XP**`, inline: true },
                    { name: '💎 Sacolas a Receber', value: `**${formatarPrata(ganho)}**`, inline: false }
                )
                .setFooter({ text: 'Use o comando /ranking no servidor para ver o Placar do Mês!' });

            const dmEnviada = await enviarDmUsuario(p.id, { embeds: [dmEmbed] });
            if (!dmEnviada) falhasDmParticipantes.push(p.id);

            return {
                userId: p.id,
                tempoMs: p.totalMs,
                valor: ganho,
                xpGanho,
                pago: false,
                pagoEmMs: null,
                pagoPorId: null
            };
        }));

        grupo.fechado = true;
        grupo.fechadoEmMs = Date.now();
        grupo.splitSacolas = {
            totalSacolas,
            totalMs: totalMsGeral,
            calculadoEmMs: Date.now(),
            calculadoPorId: interaction.user.id,
            falhasDmParticipantes,
            resultados: resultadosSplit
        };
        resultadosSplit.forEach(resultado => registrarSplitSacolaNoSaldo(evento, indexGrupo, resultado));
        grupo.bau = normalizarBauPersistido(grupo.bau);
        salvarDados();

        const embedSplit = gerarEmbedRegistroEvento(evento, indexGrupo);

        const dmLiderEnviada = await enviarDmUsuario(evento.lider, { embeds: [embedSplit] });
        const configGuild = configuracoesPorGuild.get(interaction.guild.id);
        const registroSplit = await criarCanalRegistroSplit(interaction.guild, evento, indexGrupo, embedSplit, configGuild).catch(error => {
            console.error('Erro ao criar canal de registro do split:', error);
            return { criado: false, motivo: 'erro_ao_criar' };
        });

        if (registroSplit.criado) {
            grupo.splitSacolas.registroChannelId = registroSplit.canalId;
            grupo.splitSacolas.registroMessageId = registroSplit.messageId;
        }

        const msgRelatorio = await interaction.channel.send({
            embeds: [gerarEmbedRegistroEvento(evento, indexGrupo)],
            components: gerarComponentesAberturaPainelPosSplit(evento, indexGrupo)
        });
        grupo.splitSacolas.relatorioChannelId = interaction.channel.id;
        grupo.splitSacolas.relatorioMessageId = msgRelatorio.id;
        salvarDados();

        await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
        await interaction.followUp({
            content: `✅ Split de sacolas concluído. DM do líder: **${dmLiderEnviada ? 'enviada' : 'não entregue'}**. DMs dos participantes com falha: **${falhasDmParticipantes.length}**. Registro: **${registroSplit.criado ? `criado em <#${registroSplit.canalId}>` : 'não criado'}**.\n📦 Agora use **Gerenciar Baú** no relatório para informar print, valor bruto e reparo.`,
            ephemeral: true
        });
    }

    // PAINEL PÓS-FECHAMENTO: PAGAMENTOS DE SACOLAS
    if (interaction.isButton() && interaction.customId.startsWith('dash_payment_panel_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode abrir este painel.', ephemeral: true });
        return interaction.reply(gerarPainelPagamentosGrupo(evento, indexGrupo));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_pay_sacola_')) {
        const [, , , idEvento, indexGrupo, userId] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode confirmar pagamentos.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        const resultado = grupo?.splitSacolas?.resultados?.find(item => item.userId === userId);
        if (!resultado) return interaction.reply({ content: '❌ Participante não encontrado no checklist.', ephemeral: true });
        resultado.pago = true;
        resultado.pagoEmMs = Date.now();
        resultado.pagoPorId = interaction.user.id;
        marcarSacolaPagaNoSaldo(evento, indexGrupo, userId, interaction.user.id);
        salvarDados();
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.update(gerarPainelPagamentosGrupo(evento, indexGrupo));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_pay_all_sacola_')) {
        const [, , , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode confirmar pagamentos.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo?.splitSacolas) return interaction.reply({ content: '❌ Checklist de sacolas não encontrado.', ephemeral: true });
        grupo.splitSacolas.resultados.forEach(resultado => {
            if (!resultado.pago) {
                resultado.pago = true;
                resultado.pagoEmMs = Date.now();
                resultado.pagoPorId = interaction.user.id;
                marcarSacolaPagaNoSaldo(evento, indexGrupo, resultado.userId, interaction.user.id);
            }
        });
        salvarDados();
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.update(gerarPainelPagamentosGrupo(evento, indexGrupo));
    }

    // PAINEL PÓS-FECHAMENTO: BAÚ
    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_panel_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        return interaction.reply(gerarPainelBauGrupo(evento, indexGrupo));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_informar_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        return interaction.showModal(criarModalBau(idEvento, indexGrupo));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_ultimo_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        const printUrl = await buscarUltimoPrintBau(interaction.channel, interaction.user.id);
        if (!printUrl) return interaction.reply({ content: '❌ Não encontrei imagem recente enviada por você neste canal. Envie o print do baú e tente novamente.', ephemeral: true });
        return interaction.showModal(criarModalBau(idEvento, indexGrupo, printUrl));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_sem_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        grupo.bau = { ...criarEstadoBauPadrao(), status: 'sem_bau', decisao: 'sem_bau' };
        salvarDados();
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.update(gerarPainelBauGrupo(evento, indexGrupo));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_bau_') && !interaction.customId.startsWith('modal_bau_buyout_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo?.splitSacolas) return interaction.reply({ content: '❌ Feche primeiro o split de sacolas.', ephemeral: true });
        const valorBruto = parseValorPrata(interaction.fields.getTextInputValue('bau_valor_bruto'));
        const valorReparo = parseValorPrata(interaction.fields.getTextInputValue('bau_valor_reparo'));
        const printUrl = String(interaction.fields.getTextInputValue('bau_print_url') || '').trim() || null;
        const localLoot = limitarTexto(String(interaction.fields.getTextInputValue('bau_local') || '').trim(), 80);
        const descontoPercentual = parsePercentualDesconto(interaction.fields.getTextInputValue('bau_desconto'), 20);
        grupo.bau = {
            ...criarEstadoBauPadrao(),
            status: 'aguardando_decisao',
            printUrl,
            localLoot,
            descontoPercentual,
            valorBruto,
            valorReparo,
            valorLiquido: Math.max(0, valorBruto - valorReparo),
            informadoEmMs: Date.now(),
            informadoPorId: interaction.user.id
        };
        salvarDados();
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.reply(gerarPainelBauGrupo(evento, indexGrupo));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_buyout_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (grupo?.bau?.status !== 'aguardando_decisao') return interaction.reply({ content: '❌ Informe os dados do baú antes de registrar compra interna.', ephemeral: true });
        return interaction.showModal(criarModalBuyoutBau(evento, indexGrupo));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_bau_buyout_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (grupo?.bau?.status !== 'aguardando_decisao') return interaction.reply({ content: '❌ Este baú não está aguardando decisão.', ephemeral: true });
        const compradorId = extrairUserIdTexto(interaction.fields.getTextInputValue('bau_comprador'));
        if (!compradorId || !grupo.participantes.some(p => p.id === compradorId)) {
            return interaction.reply({ content: '❌ Informe a menção ou ID de um membro da própria PT.', ephemeral: true });
        }
        const valorPago = parseValorPrata(interaction.fields.getTextInputValue('bau_valor_pago'));
        if (valorPago <= 0) return interaction.reply({ content: '❌ Informe um valor pago maior que zero.', ephemeral: true });

        const splitFinal = calcularSplitValorPorTempo(grupo, valorPago);
        grupo.bau.status = 'comprado_interno';
        grupo.bau.decisao = 'buyout';
        grupo.bau.compradorId = compradorId;
        grupo.bau.valorPago = valorPago;
        grupo.bau.splitFinal = splitFinal;
        grupo.bau.encerradoEmMs = Date.now();
        grupo.bau.encerradoPorId = interaction.user.id;
        splitFinal.resultados.forEach(resultado => registrarSplitBauNoSaldo(evento, indexGrupo, resultado, 'Baú compra interna'));
        salvarDados();

        for (const resultado of splitFinal.resultados) {
            const dmEmbed = new EmbedBuilder()
                .setTitle(`📦 Split do Baú: ${evento.nome}`)
                .setColor('#2ecc71')
                .setDescription(`O baú do **Grupo ${parseInt(indexGrupo) + 1}** foi comprado internamente por <@${compradorId}>.`)
                .addFields(
                    { name: 'Valor pago', value: formatarPrata(valorPago), inline: true },
                    { name: 'Sua parte', value: `**${formatarPrata(resultado.valor)}**`, inline: true }
                );
            await enviarDmUsuario(resultado.userId, { embeds: [dmEmbed] });
        }

        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        await interaction.channel.send({ embeds: [gerarEmbedRegistroEvento(evento, indexGrupo)] }).catch(() => null);
        return interaction.reply({ content: `✅ Compra interna registrada. O baú foi splitado em **${formatarPrata(valorPago)}**.`, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_leilao_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode enviar o baú para leilão.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        const bau = grupo?.bau;
        if (bau?.status !== 'aguardando_decisao') return interaction.reply({ content: '❌ Informe os dados do baú antes de iniciar o leilão.', ephemeral: true });
        if (!bau.printUrl || !urlImagemValida(bau.printUrl)) return interaction.reply({ content: '❌ Informe um print válido do baú antes de criar o leilão.', ephemeral: true });
        if (bau.valorLiquido <= 0) return interaction.reply({ content: '❌ O valor líquido precisa ser maior que zero para iniciar leilão.', ephemeral: true });

        const configGuild = configuracoesPorGuild.get(interaction.guild.id);
        if (!configGuild?.categoriaLeiloesId) return interaction.reply({ content: '❌ Configure a **categoria_leiloes** em /configuracoes antes de enviar baús para leilão.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });

        const categoria = interaction.guild.channels.cache.get(configGuild.categoriaLeiloesId) || await interaction.guild.channels.fetch(configGuild.categoriaLeiloesId).catch(() => null);
        if (!categoria || categoria.type !== ChannelType.GuildCategory) return interaction.editReply({ content: '❌ Categoria de leilões inválida ou inacessível.' });

        const idx = normalizarIndexGrupo(indexGrupo);
        const slugEvento = criarSlug(evento.nome);
        const permissionOverwrites = [];
        if (configGuild.cargoLeilaoId) {
            permissionOverwrites.push({
                id: configGuild.cargoLeilaoId,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
            });
        }
        const opcoesCanalLeilao = {
            name: `leilao-g${idx + 1}-${slugEvento}`.slice(0, 95),
            type: ChannelType.GuildText,
            parent: categoria.id,
            topic: `Leilão temporário do baú do evento ${evento.nome} | Grupo ${idx + 1}`
        };
        if (permissionOverwrites.length > 0) opcoesCanalLeilao.permissionOverwrites = permissionOverwrites;
        const canalLeilao = await interaction.guild.channels.create(opcoesCanalLeilao);

        bau.status = 'em_leilao';
        bau.decisao = 'leilao';
        bau.leilao = {
            channelId: canalLeilao.id,
            messageId: null,
            lanceInicial: calcularLanceInicial(bau.valorLiquido, bau.descontoPercentual),
            maiorLance: 0,
            maiorLicitanteId: null,
            criadoEmMs: Date.now(),
            criadoPorId: interaction.user.id
        };

        const msgLeilao = await canalLeilao.send({
            content: `🏷️ **Leilão aberto para o baú do evento ${evento.nome} — Grupo ${idx + 1}.**${configGuild.cargoLeilaoId ? `\nResponsáveis: <@&${configGuild.cargoLeilaoId}>` : ''}`,
            embeds: [gerarEmbedLeilao(evento, indexGrupo)],
            components: gerarComponentesLeilao(evento, indexGrupo),
            allowedMentions: configGuild.cargoLeilaoId ? { roles: [configGuild.cargoLeilaoId] } : undefined
        });
        bau.leilao.messageId = msgLeilao.id;
        salvarDados();
        await estenderRetencaoRegistroLeilao(interaction.guild, grupo);
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.editReply({ content: `✅ Leilão criado em <#${canalLeilao.id}> com lance inicial de **${formatarPrata(bau.leilao.lanceInicial)}**.` });
    }

    if (interaction.isButton() && interaction.customId.startsWith('auction_bid_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!evento || grupo?.bau?.status !== 'em_leilao') return interaction.reply({ content: '❌ Este leilão não está ativo.', ephemeral: true });
        const modal = new ModalBuilder().setCustomId(`modal_auction_bid_${idEvento}_${indexGrupo}`).setTitle('Dar Lance');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('valor_lance').setLabel('Valor do lance').setPlaceholder('Ex: 4.800.000').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_auction_bid_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        const leilao = grupo?.bau?.leilao;
        if (!evento || grupo?.bau?.status !== 'em_leilao' || !leilao) return interaction.reply({ content: '❌ Este leilão não está ativo.', ephemeral: true });
        const valorLance = parseValorPrata(interaction.fields.getTextInputValue('valor_lance'));
        if (valorLance < leilao.lanceInicial) return interaction.reply({ content: `❌ O lance mínimo é **${formatarPrata(leilao.lanceInicial)}**.`, ephemeral: true });
        if (leilao.maiorLance && valorLance <= leilao.maiorLance) return interaction.reply({ content: `❌ O lance precisa superar o atual: **${formatarPrata(leilao.maiorLance)}**.`, ephemeral: true });

        leilao.maiorLance = valorLance;
        leilao.maiorLicitanteId = interaction.user.id;
        leilao.atualizadoEmMs = Date.now();
        salvarDados();

        const canalLeilao = interaction.guild.channels.cache.get(leilao.channelId) || await interaction.guild.channels.fetch(leilao.channelId).catch(() => null);
        const msgLeilao = canalLeilao?.messages ? await canalLeilao.messages.fetch(leilao.messageId).catch(() => null) : null;
        if (msgLeilao) await msgLeilao.edit({ embeds: [gerarEmbedLeilao(evento, indexGrupo)], components: gerarComponentesLeilao(evento, indexGrupo) }).catch(() => null);
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.reply({ content: `✅ Lance registrado: **${formatarPrata(valorLance)}**.`, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('auction_close_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        const ehAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
        const podeOperarLeilao = await usuarioPodeOperarLeilao(interaction, evento.guildId);
        if (!usuarioPodeGerenciarEvento(interaction, evento) && !ehAdmin && !podeOperarLeilao) return interaction.reply({ content: '❌ Apenas o líder, criador do evento, administrador ou cargo responsável por leilões pode encerrar o leilão.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        const leilao = grupo?.bau?.leilao;
        if (grupo?.bau?.status !== 'em_leilao' || !leilao) return interaction.reply({ content: '❌ Este leilão não está ativo.', ephemeral: true });
        if (!leilao.maiorLance || !leilao.maiorLicitanteId) return interaction.reply({ content: '❌ Ainda não há lance para encerrar este leilão.', ephemeral: true });

        const splitFinal = calcularSplitValorPorTempo(grupo, leilao.maiorLance);
        grupo.bau.status = 'vendido_leilao';
        grupo.bau.decisao = 'leilao';
        grupo.bau.compradorId = leilao.maiorLicitanteId;
        grupo.bau.valorPago = leilao.maiorLance;
        grupo.bau.splitFinal = splitFinal;
        grupo.bau.encerradoEmMs = Date.now();
        grupo.bau.encerradoPorId = interaction.user.id;
        splitFinal.resultados.forEach(resultado => registrarSplitBauNoSaldo(evento, indexGrupo, resultado, 'Baú leiloado'));
        salvarDados();

        const msgLeilao = await interaction.channel.messages.fetch(leilao.messageId).catch(() => null);
        if (msgLeilao) await msgLeilao.edit({ embeds: [gerarEmbedLeilao(evento, indexGrupo)], components: gerarComponentesLeilao(evento, indexGrupo) }).catch(() => null);

        for (const resultado of splitFinal.resultados) {
            const dmEmbed = new EmbedBuilder()
                .setTitle(`📦 Split do Baú Leiloado: ${evento.nome}`)
                .setColor('#2ecc71')
                .setDescription(`O leilão do baú do **Grupo ${parseInt(indexGrupo) + 1}** foi encerrado.`)
                .addFields(
                    { name: 'Vencedor', value: `<@${leilao.maiorLicitanteId}>`, inline: true },
                    { name: 'Valor final', value: formatarPrata(leilao.maiorLance), inline: true },
                    { name: 'Sua parte', value: `**${formatarPrata(resultado.valor)}**`, inline: false }
                );
            await enviarDmUsuario(resultado.userId, { embeds: [dmEmbed] });
        }

        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        await interaction.channel.send({ embeds: [gerarEmbedRegistroEvento(evento, indexGrupo)] }).catch(() => null);
        return interaction.reply({ content: `✅ Leilão encerrado por **${formatarPrata(leilao.maiorLance)}**. Registro atualizado.`, ephemeral: true });
    }

    // SALDO: SOLICITAÇÃO E PAGAMENTO DE RESGATE
    if (interaction.isButton() && interaction.customId.startsWith('saldo_resgate_')) {
        const resto = interaction.customId.slice('saldo_resgate_'.length);
        const [guildId, userId] = resto.split('_');
        return solicitarResgateSaldo(interaction, guildId, userId);
    }

    if (interaction.isButton() && interaction.customId.startsWith('saldo_pagar_')) {
        const resto = interaction.customId.slice('saldo_pagar_'.length);
        const [guildId, userId, resgateId] = resto.split('_');
        return marcarResgateComoPago(interaction, guildId, userId, resgateId);
    }

    // BOTÃO: SAIR DO EVENTO
    if (interaction.isButton() && (interaction.customId.startsWith('dash_leave_') || interaction.customId.startsWith('leave_all_'))) {
        const isDash = interaction.customId.startsWith('dash_leave_');
        const idEvento = isDash ? interaction.customId.split('_')[2] : extrairIdEvento(interaction.customId, 'leave_all_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (evento) {
            for (const [index, grupo] of evento.grupos.entries()) {
                grupo.participantes = grupo.participantes.filter(p => p.id !== interaction.user.id);
                if (grupo.canalVozId) await interaction.guild.channels.cache.get(grupo.canalVozId)?.permissionOverwrites.delete(interaction.user.id).catch(()=>null);
                if (grupo.canalTextoId) await interaction.guild.channels.cache.get(grupo.canalTextoId)?.permissionOverwrites.delete(interaction.user.id).catch(()=>null);
                if (isDash && parseInt(interaction.customId.split('_')[3]) === index) await atualizarMsgDashboard(interaction.guild, evento, index);
            }
            await atualizarMensagemPrincipalEvento(interaction.guild, evento);
            salvarDados();
            if (isDash) await interaction.reply({ content: '✅ Removido.', ephemeral: true });
            else await interaction.update(gerarInterface(evento));
        }
    }

    // BOTÃO: ENCERRAR EVENTO DEFINITIVO
    if (interaction.isButton() && interaction.customId.startsWith('end_event_')) {
        const idEvento = extrairIdEvento(interaction.customId, 'end_event_');
        let evento = obterEvento(idEvento, interaction);

        if (!evento) {
            if (!usuarioPodeEncerrarMensagemAntiga(interaction, idEvento)) {
                return interaction.reply({
                    content: '❌ Este evento não está mais na memória do bot (reinício ou dados antigos). Apenas o **líder**, quem **criou** o evento ou um **administrador** pode encerrar esta mensagem.',
                    ephemeral: true
                });
            }
            return encerrarMensagemEventoSemMemoria(interaction, idEvento);
        }

        const ehCriador = interaction.user.id === evento.criadoPorId;
        const ehLider = interaction.user.id === evento.lider;
        const ehAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
        if (!ehCriador && !ehLider && !ehAdmin) {
            return interaction.reply({ content: '❌ Apenas o administrador, o líder ou quem criou o evento pode encerrá-lo.', ephemeral: true });
        }

        const manterPorLeilaoAberto = eventoTemLeilaoAberto(evento);
        for (const grupo of evento.grupos) {
            if (grupo.canalVozId) await interaction.guild.channels.cache.get(grupo.canalVozId)?.delete().catch(() => null);
            if (grupo.canalTextoId) await interaction.guild.channels.cache.get(grupo.canalTextoId)?.delete().catch(() => null);
            grupo.canalVozId = null;
            grupo.canalTextoId = null;
            grupo.dashboardMsgId = null;
        }

        if (manterPorLeilaoAberto) {
            evento.encerradoDefinitivo = true;
            evento.encerradoDefinitivoEmMs = Date.now();
            salvarDados();
        } else {
            removerEventoPersistido(idEvento);
        }

        const detalhe = manterPorLeilaoAberto
            ? 'As salas do evento foram apagadas, mas o registro ficou armazenado por causa de leilão em aberto. O split do baú continuará funcionando no canal de leilão.'
            : undefined;
        await interaction.update({ embeds: [gerarEmbedEventoEncerrado(interaction.user.id, detalhe)], components: [] });
    }
    } catch (error) {
        console.error('Erro ao processar interação:', error);
        const respostaErro = { content: '❌ Ocorreu um erro ao processar esta ação. Verifique o console do bot para mais detalhes.', ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.followUp(respostaErro).catch(() => null);
        else await interaction.reply(respostaErro).catch(() => null);
    }
});

client.login(DISCORD_TOKEN);
require('dotenv').config();
const {
    Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
    ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder,
    ChannelType, PermissionFlagsBits, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const cron = require('cron');
const fs = require('fs');
const path = require('path');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });
const eventosAtivos = new Map();
const configuracoesPorGuild = new Map();
const CONFIG_PATH = path.join(__dirname, 'guild-config.json');
const XP_PATH = path.join(__dirname, 'xp-config.json');
const REGISTROS_PATH = path.join(__dirname, 'registros-canais.json');
const EVENTOS_PATH = path.join(__dirname, 'eventos-ativos.json');
const SALDOS_PATH = path.join(__dirname, 'saldos-membros.json');
const xpMembros = new Map();
const registrosCanais = new Map();
const saldosMembros = new Map();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const TIME_ZONE = process.env.TIME_ZONE || 'America/Sao_Paulo';
const MINUTOS_ABERTURA_SALA = 30;
const MAX_OPCOES_MENU = 25;
const DIAS_RETENCAO_REGISTROS = 5;
const DIAS_RETENCAO_REGISTROS_LEILAO = 30;
const DIAS_UTEIS_LEILAO = 6;
const TEMPO_RETENCAO_REGISTROS_MS = DIAS_RETENCAO_REGISTROS * 24 * 60 * 60 * 1000;
const TEMPO_RETENCAO_REGISTROS_LEILAO_MS = DIAS_RETENCAO_REGISTROS_LEILAO * 24 * 60 * 60 * 1000;
const STATUS_LEILAO_ABERTO = 'em_leilao';
const STATUS_LEILAO_REVISAO = 'leilao_revisao';
const STATUS_LEILAO_VENDIDO = 'vendido_leilao';

if (!DISCORD_TOKEN || !CLIENT_ID) {
    console.error('Erro: configure DISCORD_TOKEN e CLIENT_ID no arquivo .env antes de iniciar o bot.');
    process.exit(1);
}

// ==========================================
// BANCOS DE DADOS LOCAIS (JSON)
// ==========================================
function carregarDados() {
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const dados = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            Object.entries(dados).forEach(([guildId, config]) => {
                if (config?.categoriaId && config?.cargoEventoId) configuracoesPorGuild.set(guildId, config);
            });
        } catch (e) { console.error('Erro ao ler guild-config.json', e); }
    }
    if (fs.existsSync(XP_PATH)) {
        try {
            const dados = JSON.parse(fs.readFileSync(XP_PATH, 'utf8'));
            Object.entries(dados).forEach(([chave, xp]) => xpMembros.set(chave, xp));
        } catch (e) { console.error('Erro ao ler xp-config.json', e); }
    }
    if (fs.existsSync(REGISTROS_PATH)) {
        try {
            const dados = JSON.parse(fs.readFileSync(REGISTROS_PATH, 'utf8'));
            Object.entries(dados).forEach(([channelId, registro]) => registrosCanais.set(channelId, registro));
        } catch (e) { console.error('Erro ao ler registros-canais.json', e); }
    }
    if (fs.existsSync(EVENTOS_PATH)) {
        try {
            const dados = JSON.parse(fs.readFileSync(EVENTOS_PATH, 'utf8'));
            Object.entries(dados).forEach(([eventoId, evento]) => {
                if (!evento?.id || !Array.isArray(evento.grupos)) return;
                evento.grupos.forEach(grupo => normalizarGrupoPersistido(grupo));
                eventosAtivos.set(eventoId, evento);
            });
        } catch (e) { console.error('Erro ao ler eventos-ativos.json', e); }
    }
    if (fs.existsSync(SALDOS_PATH)) {
        try {
            const dados = JSON.parse(fs.readFileSync(SALDOS_PATH, 'utf8'));
            Object.entries(dados).forEach(([chave, saldo]) => saldosMembros.set(chave, normalizarSaldoMembro(saldo)));
        } catch (e) { console.error('Erro ao ler saldos-membros.json', e); }
    }
}

function salvarDados() {
    try {
        const objetoConfig = Object.fromEntries(configuracoesPorGuild.entries());
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(objetoConfig, null, 2), 'utf8');

        const objetoXP = Object.fromEntries(xpMembros.entries());
        fs.writeFileSync(XP_PATH, JSON.stringify(objetoXP, null, 2), 'utf8');

        const objetoRegistros = Object.fromEntries(registrosCanais.entries());
        fs.writeFileSync(REGISTROS_PATH, JSON.stringify(objetoRegistros, null, 2), 'utf8');

        const objetoEventos = Object.fromEntries(eventosAtivos.entries());
        fs.writeFileSync(EVENTOS_PATH, JSON.stringify(objetoEventos, null, 2), 'utf8');

        const objetoSaldos = Object.fromEntries(saldosMembros.entries());
        fs.writeFileSync(SALDOS_PATH, JSON.stringify(objetoSaldos, null, 2), 'utf8');
    } catch (e) { console.error('Erro ao salvar arquivos de banco de dados locais', e); }
}
carregarDados();

// ==========================================
// FUNÇÕES AUXILIARES DE CÁLCULO E TEMPO
// ==========================================
function obterAnoMes(date = new Date()) {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(date);
    const ano = partes.find(p => p.type === 'year')?.value;
    const mes = partes.find(p => p.type === 'month')?.value;
    return `${ano}-${mes}`;
}

function obterChaveXp(guildId, userId, date = new Date()) {
    return `${guildId}_${obterAnoMes(date)}_${userId}`;
}

function membroPodeCriarEvento(interaction, configGuild) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    return Boolean(configGuild?.cargoEventoId && interaction.member?.roles?.cache?.has(configGuild.cargoEventoId));
}

function membroTemCargoLeilao(interaction, configGuild) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    return Boolean(configGuild?.cargoLeilaoId && interaction.member?.roles?.cache?.has(configGuild.cargoLeilaoId));
}

async function usuarioPodeOperarLeilao(interaction, guildId) {
    const configGuild = configuracoesPorGuild.get(guildId);
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (interaction.member?.roles?.cache?.has(configGuild?.cargoLeilaoId)) return true;
    if (!configGuild?.cargoLeilaoId) return false;

    const guild = interaction.guild || client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const membro = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;
    return Boolean(membro?.roles?.cache?.has(configGuild.cargoLeilaoId));
}

function horarioValido(horario) {
    if (!/^\d{1,2}:\d{2}$/.test(horario || '')) return false;
    const [hora, minuto] = horario.split(':').map(Number);
    return Number.isInteger(hora) && Number.isInteger(minuto) && hora >= 0 && hora <= 23 && minuto >= 0 && minuto <= 59;
}

function criarSlug(texto, fallback = 'evento') {
    const slug = String(texto || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60);
    return slug || fallback;
}

function normalizarSegmentoNomeSala(texto, fallback = 'canal') {
    const segmento = String(texto || '')
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .slice(0, 32);
    return segmento || fallback;
}

async function obterNomeExibicaoUsuario(guild, userId, fallback = 'Lider') {
    let membro = guild?.members?.cache?.get(userId) || null;
    if (!membro && guild?.members?.fetch) membro = await guild.members.fetch(userId).catch(() => null);
    if (membro?.displayName) return membro.displayName;

    const usuario = membro?.user || await client.users.fetch(userId).catch(() => null);
    return usuario?.globalName || usuario?.username || fallback;
}

async function gerarNomeSalaGrupo(guild, evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const nomeLider = await obterNomeExibicaoUsuario(guild, evento.lider);
    const lider = normalizarSegmentoNomeSala(nomeLider, 'Lider');
    const conteudo = normalizarSegmentoNomeSala(evento.nome, 'Conteudo');
    return `${lider}-Grupo${idx + 1}-${conteudo}`.slice(0, 95);
}

const ROLE_SLUGS = {
    TANK: 'TANK',
    HEALER: 'HEALER',
    SUPORTE: 'SUPORTE',
    DPS: 'DPS',
    'DPS RANGER': 'DPS_RANGER'
};
const SLUG_TO_ROLE = Object.fromEntries(Object.entries(ROLE_SLUGS).map(([role, slug]) => [slug, role]));

function roleParaSlug(role) {
    return ROLE_SLUGS[role] || String(role).replace(/\s+/g, '_');
}

function slugParaRole(slug) {
    return SLUG_TO_ROLE[slug] || String(slug).replace(/_/g, ' ');
}

function normalizarIndexGrupo(indexGrupo) {
    return parseInt(indexGrupo, 10);
}

function extrairIdEvento(customId, prefixo) {
    return customId.startsWith(prefixo) ? customId.slice(prefixo.length) : null;
}

function recarregarEventoDoDisco(idEvento) {
    if (!fs.existsSync(EVENTOS_PATH)) return null;
    try {
        const dados = JSON.parse(fs.readFileSync(EVENTOS_PATH, 'utf8'));
        const evento = dados[idEvento];
        if (!evento?.id || !Array.isArray(evento.grupos)) return null;
        evento.grupos.forEach(grupo => normalizarGrupoPersistido(grupo));
        eventosAtivos.set(idEvento, evento);
        return evento;
    } catch (e) {
        console.error('Erro ao recarregar evento do disco:', e);
        return null;
    }
}

function buscarEventoPorMensagemPrincipal(messageId, guildId) {
    for (const [, evento] of eventosAtivos) {
        if (evento.mensagemPrincipalId === messageId && evento.guildId === guildId) return evento;
    }
    return null;
}

function obterEvento(idEvento, interaction = null) {
    let evento = eventosAtivos.get(idEvento);
    if (!evento) evento = recarregarEventoDoDisco(idEvento);
    if (!evento && interaction?.message?.id && interaction.guild?.id) {
        evento = buscarEventoPorMensagemPrincipal(interaction.message.id, interaction.guild.id);
    }
    return evento;
}

function removerEventoPersistido(idEvento) {
    eventosAtivos.delete(idEvento);
    salvarDados();
}

const parseWeapons = (input) => {
    if (!input || input.toLowerCase() === '0' || input.toLowerCase() === 'nenhuma') return [];
    const armas = [];
    const itens = input.split(',').map(s => s.trim()).filter(s => s !== '');
    for (const item of itens) {
        let nomeArma = item; let quantidade = 1;
        const sufixo = item.match(/^(.*?)\s*(?:\*|x)\s*(\d+)$/i);
        const prefixo = item.match(/^(\d+)\s*(?:\*|x)\s*(.*?)$/i);
        const sufixoSemSeparador = item.match(/^(.*?[^\d\s])\s*(\d+)$/i);
        if (sufixo) { nomeArma = sufixo[1].trim(); quantidade = parseInt(sufixo[2], 10); }
        else if (prefixo) { quantidade = parseInt(prefixo[1], 10); nomeArma = prefixo[2].trim(); }
        else if (sufixoSemSeparador) { nomeArma = sufixoSemSeparador[1].trim(); quantidade = parseInt(sufixoSemSeparador[2], 10); }
        if (!nomeArma || Number.isNaN(quantidade) || quantidade <= 0) continue;
        for (let i = 0; i < quantidade; i++) armas.push(nomeArma);
    }
    return armas;
};

function getAvailableWeapons(requiredArray, participantsArray) {
    let available = [...requiredArray];
    participantsArray.forEach(p => {
        const idx = available.indexOf(p.arma);
        if (idx !== -1) available.splice(idx, 1);
    });
    return available;
}

function minutosAteHorario(horario) {
    if (!horarioValido(horario)) return null;
    const [horaGrupo, minGrupo] = horario.split(':').map(Number);
    const formatter = new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const [horaAtualStr, minAtualStr] = formatter.format(new Date()).split(':');
    const minAtualTotal = parseInt(horaAtualStr) * 60 + parseInt(minAtualStr);
    const minGrupoTotal = horaGrupo * 60 + minGrupo;
    let diferenca = minGrupoTotal - minAtualTotal;
    if (diferenca < 0) diferenca += 1440;
    return diferenca;
}

function formatarDuracaoMs(totalMs) {
    const ms = Math.max(0, totalMs);
    const totalSegundos = Math.floor(ms / 1000);
    const horas = Math.floor(totalSegundos / 3600);
    const minutos = Math.floor((totalSegundos % 3600) / 60);
    const segundos = totalSegundos % 60;
    if (horas > 0) return `${horas}h ${String(minutos).padStart(2, '0')}m ${String(segundos).padStart(2, '0')}s`;
    if (minutos > 0) return `${minutos}m ${String(segundos).padStart(2, '0')}s`;
    return `${segundos}s`;
}

function ehFimDeSemanaLocal(date) {
    const diaSemana = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(date);
    return diaSemana === 'Sat' || diaSemana === 'Sun';
}

function adicionarDiasUteis(baseMs = Date.now(), diasUteis = DIAS_UTEIS_LEILAO) {
    let data = new Date(Number(baseMs) || Date.now());
    let adicionados = 0;
    while (adicionados < diasUteis) {
        data = new Date(data.getTime() + 24 * 60 * 60 * 1000);
        if (!ehFimDeSemanaLocal(data)) adicionados++;
    }
    return data.getTime();
}

function formatarDataHora(ms) {
    const timestamp = Number(ms) || 0;
    if (!timestamp) return 'não definido';
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: TIME_ZONE,
        dateStyle: 'short',
        timeStyle: 'short'
    }).format(new Date(timestamp));
}

function leilaoPrazoExpirado(leilao) {
    return Boolean(leilao?.prazoEncerramentoMs && Date.now() >= leilao.prazoEncerramentoMs);
}

function textoPrazoLeilao(leilao) {
    if (!leilao?.prazoEncerramentoMs) return 'Prazo não definido';
    const prazo = formatarDataHora(leilao.prazoEncerramentoMs);
    if (Date.now() >= leilao.prazoEncerramentoMs) return `Encerrado para revisão em ${prazo}`;
    return `Encerra automaticamente para revisão em ${prazo}`;
}

function tempoTotalAtual(participante) {
    let add = (!participante.isPaused && participante.lastStartMs) ? (Date.now() - participante.lastStartMs) : 0;
    return participante.totalMs + add;
}

function parseValorPrata(valor) {
    return parseInt(String(valor || '0').replace(/\D/g, ''), 10) || 0;
}

function parsePercentualDesconto(valor, padrao = 20) {
    const texto = String(valor ?? '').replace('%', '').replace(',', '.').trim();
    const numero = Number.parseFloat(texto);
    if (!Number.isFinite(numero)) return padrao;
    return Math.min(100, Math.max(0, numero));
}

function formatarPercentual(valor) {
    return `${parsePercentualDesconto(valor).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

function formatarPrata(valor) {
    return `${Math.max(0, Math.floor(Number(valor) || 0)).toLocaleString('pt-BR')} Pratas`;
}

function chaveSaldo(guildId, userId) {
    return `${guildId}_${userId}`;
}

function normalizarSaldoMembro(saldo) {
    const normalizado = {
        guildId: saldo?.guildId || null,
        userId: saldo?.userId || null,
        lancamentos: Array.isArray(saldo?.lancamentos) ? saldo.lancamentos : [],
        resgates: Array.isArray(saldo?.resgates) ? saldo.resgates : []
    };

    normalizado.lancamentos = normalizado.lancamentos.map(lancamento => ({
        id: String(lancamento.id || ''),
        guildId: lancamento.guildId || normalizado.guildId,
        userId: lancamento.userId || normalizado.userId,
        eventoId: lancamento.eventoId || null,
        grupoIndex: Number.isInteger(lancamento.grupoIndex) ? lancamento.grupoIndex : parseInt(lancamento.grupoIndex ?? 0, 10),
        tipo: lancamento.tipo || 'split',
        descricao: lancamento.descricao || 'Split',
        valor: Math.max(0, Math.floor(Number(lancamento.valor) || 0)),
        status: lancamento.status || 'disponivel',
        criadoEmMs: lancamento.criadoEmMs || Date.now(),
        solicitadoEmMs: lancamento.solicitadoEmMs || null,
        pagoEmMs: lancamento.pagoEmMs || null,
        pagoPorId: lancamento.pagoPorId || null,
        resgateId: lancamento.resgateId || null
    })).filter(lancamento => lancamento.id);

    normalizado.resgates = normalizado.resgates.map(resgate => ({
        id: String(resgate.id || ''),
        valorTotal: Math.max(0, Math.floor(Number(resgate.valorTotal) || 0)),
        status: resgate.status || 'solicitado',
        solicitadoEmMs: resgate.solicitadoEmMs || Date.now(),
        pagoEmMs: resgate.pagoEmMs || null,
        pagoPorId: resgate.pagoPorId || null,
        lancamentoIds: Array.isArray(resgate.lancamentoIds) ? resgate.lancamentoIds : []
    })).filter(resgate => resgate.id);

    return normalizado;
}

function obterSaldoMembro(guildId, userId) {
    const chave = chaveSaldo(guildId, userId);
    const existente = saldosMembros.get(chave);
    if (existente) return existente;
    const novo = { guildId, userId, lancamentos: [], resgates: [] };
    saldosMembros.set(chave, novo);
    return novo;
}

function idLancamentoSacola(eventoId, indexGrupo, userId) {
    return `sacola_${eventoId}_${normalizarIndexGrupo(indexGrupo)}_${userId}`;
}

function idLancamentoBau(eventoId, indexGrupo, userId) {
    return `bau_${eventoId}_${normalizarIndexGrupo(indexGrupo)}_${userId}`;
}

function registrarLancamentoSaldo(guildId, userId, lancamento) {
    if (!lancamento?.id || !lancamento.valor) return null;
    const saldo = obterSaldoMembro(guildId, userId);
    const atual = saldo.lancamentos.find(item => item.id === lancamento.id);
    if (atual) {
        Object.assign(atual, { ...lancamento, status: atual.status, resgateId: atual.resgateId, solicitadoEmMs: atual.solicitadoEmMs, pagoEmMs: atual.pagoEmMs, pagoPorId: atual.pagoPorId });
        return atual;
    }
    const novo = {
        guildId,
        userId,
        status: 'disponivel',
        criadoEmMs: Date.now(),
        solicitadoEmMs: null,
        pagoEmMs: null,
        pagoPorId: null,
        resgateId: null,
        ...lancamento
    };
    saldo.lancamentos.push(novo);
    return novo;
}

function marcarLancamentoSaldoPago(guildId, userId, lancamentoId, pagoPorId) {
    const saldo = obterSaldoMembro(guildId, userId);
    const lancamento = saldo.lancamentos.find(item => item.id === lancamentoId);
    if (!lancamento) return false;
    lancamento.status = 'pago';
    lancamento.pagoEmMs = Date.now();
    lancamento.pagoPorId = pagoPorId;
    if (lancamento.resgateId) {
        const resgate = saldo.resgates.find(item => item.id === lancamento.resgateId);
        const todosPagos = resgate?.lancamentoIds?.every(id => saldo.lancamentos.find(item => item.id === id)?.status === 'pago');
        if (resgate && todosPagos) {
            resgate.status = 'pago';
            resgate.pagoEmMs = Date.now();
            resgate.pagoPorId = pagoPorId;
        }
    }
    return true;
}

function registrarSplitSacolaNoSaldo(evento, indexGrupo, resultado) {
    if (!resultado?.valor) return null;
    const idx = normalizarIndexGrupo(indexGrupo);
    return registrarLancamentoSaldo(evento.guildId, resultado.userId, {
        id: idLancamentoSacola(evento.id, idx, resultado.userId),
        eventoId: evento.id,
        grupoIndex: idx,
        tipo: 'sacolas',
        descricao: `Sacolas - ${evento.nome} | Grupo ${idx + 1}`,
        valor: resultado.valor
    });
}

function registrarSplitBauNoSaldo(evento, indexGrupo, resultado, origem) {
    if (!resultado?.valor) return null;
    const idx = normalizarIndexGrupo(indexGrupo);
    return registrarLancamentoSaldo(evento.guildId, resultado.userId, {
        id: idLancamentoBau(evento.id, idx, resultado.userId),
        eventoId: evento.id,
        grupoIndex: idx,
        tipo: 'bau',
        descricao: `${origem || 'Baú'} - ${evento.nome} | Grupo ${idx + 1}`,
        valor: resultado.valor
    });
}

function marcarSacolaPagaNoSaldo(evento, indexGrupo, userId, pagoPorId) {
    return marcarLancamentoSaldoPago(evento.guildId, userId, idLancamentoSacola(evento.id, indexGrupo, userId), pagoPorId);
}

function obterSacolaTotal(grupo) {
    return Math.max(0, Math.floor(Number(grupo?.sacolaTotal ?? grupo?.lootTotal ?? 0) || 0));
}

function definirSacolaTotal(grupo, valor) {
    const total = Math.max(0, Math.floor(Number(valor) || 0));
    grupo.sacolaTotal = total;
    grupo.lootTotal = total;
}

function criarEstadoBauPadrao() {
    return {
        status: 'nao_informado',
        printUrl: null,
        localLoot: null,
        descontoPercentual: 20,
        valorBruto: 0,
        valorReparo: 0,
        valorLiquido: 0,
        decisao: null,
        compradorId: null,
        valorPago: 0,
        splitFinal: null,
        leilao: null
    };
}

function normalizarSplitSacolasPersistido(splitSacolas) {
    if (!splitSacolas || typeof splitSacolas !== 'object') return null;
    splitSacolas.resultados = Array.isArray(splitSacolas.resultados) ? splitSacolas.resultados : [];
    splitSacolas.resultados.forEach(resultado => {
        resultado.pago = Boolean(resultado.pago);
        resultado.valor = Math.max(0, Math.floor(Number(resultado.valor) || 0));
        resultado.tempoMs = Math.max(0, Math.floor(Number(resultado.tempoMs) || 0));
        resultado.xpGanho = Number(resultado.xpGanho) || 0;
    });
    splitSacolas.totalSacolas = Math.max(0, Math.floor(Number(splitSacolas.totalSacolas) || 0));
    splitSacolas.totalMs = Math.max(0, Math.floor(Number(splitSacolas.totalMs) || 0));
    splitSacolas.falhasDmParticipantes = Array.isArray(splitSacolas.falhasDmParticipantes) ? splitSacolas.falhasDmParticipantes : [];
    return splitSacolas;
}

function normalizarBauPersistido(bau) {
    const normalizado = { ...criarEstadoBauPadrao(), ...(bau && typeof bau === 'object' ? bau : {}) };
    normalizado.valorBruto = Math.max(0, Math.floor(Number(normalizado.valorBruto) || 0));
    normalizado.valorReparo = Math.max(0, Math.floor(Number(normalizado.valorReparo) || 0));
    normalizado.valorLiquido = Math.max(0, Math.floor(Number(normalizado.valorLiquido ?? (normalizado.valorBruto - normalizado.valorReparo)) || 0));
    normalizado.valorPago = Math.max(0, Math.floor(Number(normalizado.valorPago) || 0));
    normalizado.localLoot = normalizado.localLoot ? limitarTexto(normalizado.localLoot, 80) : null;
    normalizado.descontoPercentual = parsePercentualDesconto(normalizado.descontoPercentual, 20);
    if (normalizado.splitFinal?.resultados) {
        normalizado.splitFinal.resultados = normalizado.splitFinal.resultados.map(resultado => ({
            userId: resultado.userId,
            tempoMs: Math.max(0, Math.floor(Number(resultado.tempoMs) || 0)),
            valor: Math.max(0, Math.floor(Number(resultado.valor) || 0))
        }));
    }
    if (normalizado.leilao) {
        normalizado.leilao.lanceInicial = Math.max(0, Math.floor(Number(normalizado.leilao.lanceInicial) || 0));
        normalizado.leilao.maiorLance = Math.max(0, Math.floor(Number(normalizado.leilao.maiorLance) || 0));
        normalizado.leilao.criadoEmMs = Math.max(0, Math.floor(Number(normalizado.leilao.criadoEmMs) || Date.now()));
        normalizado.leilao.prazoEncerramentoMs = Math.max(0, Math.floor(Number(normalizado.leilao.prazoEncerramentoMs) || 0));
        normalizado.leilao.revisaoEmMs = normalizado.leilao.revisaoEmMs ? Math.max(0, Math.floor(Number(normalizado.leilao.revisaoEmMs) || 0)) : null;
        normalizado.leilao.revisaoNotificadaEmMs = normalizado.leilao.revisaoNotificadaEmMs ? Math.max(0, Math.floor(Number(normalizado.leilao.revisaoNotificadaEmMs) || 0)) : null;
        normalizado.leilao.revisadoEmMs = normalizado.leilao.revisadoEmMs ? Math.max(0, Math.floor(Number(normalizado.leilao.revisadoEmMs) || 0)) : null;
        normalizado.leilao.reabertoEmMs = normalizado.leilao.reabertoEmMs ? Math.max(0, Math.floor(Number(normalizado.leilao.reabertoEmMs) || 0)) : null;
        normalizado.leilao.historicoLances = Array.isArray(normalizado.leilao.historicoLances)
            ? normalizado.leilao.historicoLances.slice(-30).map(lance => ({
                userId: lance.userId,
                valor: Math.max(0, Math.floor(Number(lance.valor) || 0)),
                criadoEmMs: Math.max(0, Math.floor(Number(lance.criadoEmMs) || 0))
            })).filter(lance => lance.userId && lance.valor > 0)
            : [];
        if (normalizado.status === STATUS_LEILAO_ABERTO && !normalizado.leilao.prazoEncerramentoMs) {
            normalizado.leilao.prazoEncerramentoMs = adicionarDiasUteis(normalizado.leilao.criadoEmMs, DIAS_UTEIS_LEILAO);
        }
    }
    return normalizado;
}

function membroEstaNaSalaVoz(guild, grupo, userId) {
    if (!guild || !grupo?.canalVozId) return false;
    return guild.voiceStates.cache.get(userId)?.channelId === grupo.canalVozId;
}

function iniciarCronometroParticipante(participante) {
    if (!participante.isPaused && !participante.lastStartMs) participante.lastStartMs = Date.now();
}

function pararCronometroParticipante(participante) {
    if (participante.lastStartMs) {
        participante.totalMs += Date.now() - participante.lastStartMs;
        participante.lastStartMs = null;
    }
}

function togglePause(participante) {
    if (participante.isPaused) {
        participante.isPaused = false;
    } else {
        pararCronometroParticipante(participante);
        participante.isPaused = true;
    }
}

function normalizarGrupoPersistido(grupo) {
    grupo.participantes = Array.isArray(grupo.participantes) ? grupo.participantes : [];
    grupo.participantes.forEach(p => { p.lastStartMs = null; });
    grupo.fechado = Boolean(grupo.fechado);
    definirSacolaTotal(grupo, obterSacolaTotal(grupo));
    grupo.splitSacolas = normalizarSplitSacolasPersistido(grupo.splitSacolas);
    grupo.bau = normalizarBauPersistido(grupo.bau);
    grupo.conteudoEstado = grupo.conteudoEstado || 'aguardando';
    grupo.conteudoTempoAcumuladoMs = grupo.conteudoTempoAcumuladoMs || 0;
    if (grupo.conteudoEstado === 'rodando') {
        if (grupo.conteudoRodandoDesdeMs) {
            grupo.conteudoTempoAcumuladoMs += Math.max(0, Date.now() - grupo.conteudoRodandoDesdeMs);
        }
        grupo.conteudoEstado = 'pausado';
        grupo.conteudoRodandoDesdeMs = null;
    }
}

function tempoConteudoAtual(grupo) {
    let ms = grupo.conteudoTempoAcumuladoMs || 0;
    if (grupo.conteudoEstado === 'rodando' && grupo.conteudoRodandoDesdeMs) {
        ms += Date.now() - grupo.conteudoRodandoDesdeMs;
    }
    return ms;
}

function obterStatusConteudoGrupo(grupo) {
    const tempo = formatarDuracaoMs(tempoConteudoAtual(grupo));
    if (grupo.conteudoEstado === 'rodando') return `▶️ Conteúdo em andamento — ${tempo}`;
    if (grupo.conteudoEstado === 'pausado') return `⏸️ Conteúdo pausado — ${tempo}`;
    return `⏳ Aguardando Play do líder — ${tempo}`;
}

function emojiStatusParticipante(grupo, participante) {
    if (participante.isPaused) return '⏸️';
    if (grupo.conteudoEstado !== 'rodando') return '⏳';
    if (participante.lastStartMs) return '▶️';
    return '🔇';
}

function pausarConteudoGrupo(grupo) {
    if (grupo.conteudoEstado === 'rodando' && grupo.conteudoRodandoDesdeMs) {
        grupo.conteudoTempoAcumuladoMs = (grupo.conteudoTempoAcumuladoMs || 0) + (Date.now() - grupo.conteudoRodandoDesdeMs);
        grupo.conteudoRodandoDesdeMs = null;
    }
    grupo.conteudoEstado = 'pausado';
    grupo.participantes.forEach(p => pararCronometroParticipante(p));
}

function retomarConteudoGrupo(guild, grupo) {
    if (!grupo.conteudoInicioMs) grupo.conteudoInicioMs = Date.now();
    grupo.conteudoEstado = 'rodando';
    grupo.conteudoRodandoDesdeMs = Date.now();
    sincronizarCronometrosGrupo(guild, grupo);
}

function iniciarConteudoGrupo(guild, grupo) {
    if (!grupo.conteudoInicioMs) grupo.conteudoInicioMs = Date.now();
    grupo.conteudoEstado = 'rodando';
    grupo.conteudoRodandoDesdeMs = Date.now();
    sincronizarCronometrosGrupo(guild, grupo);
}

function alternarConteudoGrupo(guild, grupo) {
    if (grupo.conteudoEstado === 'rodando') {
        pausarConteudoGrupo(grupo);
        return 'pausado';
    }
    if (grupo.conteudoEstado === 'pausado') {
        retomarConteudoGrupo(guild, grupo);
        return 'rodando';
    }
    iniciarConteudoGrupo(guild, grupo);
    return 'rodando';
}

function finalizarConteudoGrupo(grupo) {
    pausarConteudoGrupo(grupo);
}

function sincronizarParticipanteSeElegivel(guild, grupo, participante) {
    if (grupo.conteudoEstado !== 'rodando' || participante.isPaused) {
        pararCronometroParticipante(participante);
        return;
    }
    if (membroEstaNaSalaVoz(guild, grupo, participante.id)) iniciarCronometroParticipante(participante);
    else pararCronometroParticipante(participante);
}

function deveAbrirSalaGrupo(grupo) {
    if (!grupo?.inicioPrevistoMs || grupo.canalVozId) return false;
    return Date.now() >= grupo.inicioPrevistoMs - (MINUTOS_ABERTURA_SALA * 60 * 1000);
}

function sincronizarCronometrosGrupo(guild, grupo) {
    if (!guild || !grupo?.canalVozId || grupo.fechado) return;
    if (grupo.conteudoEstado !== 'rodando') {
        grupo.participantes.forEach(p => pararCronometroParticipante(p));
        return;
    }
    grupo.participantes.forEach(participante => sincronizarParticipanteSeElegivel(guild, grupo, participante));
}

// ==========================================
// INTERFACES (EMBEDS E DASHBOARDS)
// ==========================================
function gerarDashboardGrupo(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const sacolaFormatada = obterSacolaTotal(grupo).toLocaleString('pt-BR');
    const statusBau = textoStatusBau(grupo);

    const embed = new EmbedBuilder()
        .setTitle(`🛡️ GERENCIAMENTO DE GRUPO: BLOCO ${idx + 1}`)
        .setColor(grupo.conteudoEstado === 'rodando' ? '#2ecc71' : '#95a5a6')
        .setDescription(`**Horário Oficial:** ${grupo.horario}\n**Tempo de Conteúdo:** ⏱️ ${obterStatusConteudoGrupo(grupo)}\n**Sacolas/Prata Bruta:** 💰 \`${sacolaFormatada} Pratas\`\n**Baú:** ${statusBau}\n\n*O tempo só conta após o líder iniciar o conteúdo (Play).*`);

    let listagem = '';
    grupo.participantes.forEach(p => {
        const statusEmoji = emojiStatusParticipante(grupo, p);
        const tempo = formatarDuracaoMs(tempoTotalAtual(p));
        listagem += `${statusEmoji} \`[${tempo}]\` <@${p.id}> — **${p.role}** [${p.arma}]\n`;
    });

    adicionarCampoLongo(embed, '👥 Participantes e Cronômetros', listagem || '*Nenhum participante restando no grupo.*');

    if (grupo.fechado) {
        embed.setColor('#7f8c8d');
        embed.addFields({ name: '✅ Status', value: '*Split de sacolas fechado. Use o painel pós-fechamento para pagamentos e baú.*', inline: false });
        return { embeds: [embed], components: [] };
    }

    const btnRow1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dash_pause_self_${evento.id}_${idx}`).setLabel('Pausar/Retomar Meu Tempo').setEmoji('⏱️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`dash_leave_${evento.id}_${idx}`).setLabel('Sair do Evento').setEmoji('❌').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`dash_leader_panel_${evento.id}_${idx}`).setLabel('Painel do Líder').setEmoji('👑').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [btnRow1] };
}

function usuarioPodeGerenciarEvento(interaction, evento) {
    return Boolean(evento && (interaction.user.id === evento.lider || interaction.user.id === evento.criadoPorId));
}

function gerarPainelLiderGrupo(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    if (!grupo) {
        return { content: '❌ Este grupo não está disponível.', components: [], ephemeral: true };
    }
    if (grupo.fechado) {
        return gerarPainelPagamentosGrupo(evento, idx);
    }

    const estadoConteudo = grupo.conteudoEstado || 'aguardando';
    let labelConteudo = 'Iniciar Conteúdo (Play)';
    let emojiConteudo = '▶️';
    let styleConteudo = ButtonStyle.Success;
    if (estadoConteudo === 'rodando') {
        labelConteudo = 'Pausar Conteúdo';
        emojiConteudo = '⏸️';
        styleConteudo = ButtonStyle.Danger;
    } else if (estadoConteudo === 'pausado') {
        labelConteudo = 'Retomar Conteúdo';
        emojiConteudo = '▶️';
        styleConteudo = ButtonStyle.Success;
    }

    const btnRowConteudo = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dash_conteudo_timer_${evento.id}_${idx}`).setLabel(labelConteudo).setEmoji(emojiConteudo).setStyle(styleConteudo)
    );

    const btnRowLider = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dash_add_loot_${evento.id}_${idx}`).setLabel('Adicionar Sacolas').setEmoji('💰').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`dash_calc_split_${evento.id}_${idx}`).setLabel('Finalizar & Calcular Split').setEmoji('⚖️').setStyle(ButtonStyle.Secondary)
    );

    const componentes = [btnRowConteudo, btnRowLider];
    const opcoesMembros = grupo.participantes.map(p => ({ label: limitarTexto(`Alternar Pause: ${p.role} [${p.arma}]`), description: `Membro ID: ${p.id}`, value: p.id })).slice(0, MAX_OPCOES_MENU);
    if (opcoesMembros.length > 0) {
        componentes.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`dash_force_pause_${evento.id}_${idx}`).setPlaceholder('👑 Forçar pause/retomar de um membro...').addOptions(opcoesMembros)));
    }

    return {
        content: `👑 **Painel do Líder — Grupo ${idx + 1}**\n${obterStatusConteudoGrupo(grupo)}\n*Pausar o conteúdo pausa todos os cronômetros. Pause individual só afeta um membro.*`,
        components: componentes,
        ephemeral: true
    };
}

async function atualizarMsgDashboard(guild, evento, indexGrupo) {
    const grupo = evento?.grupos[indexGrupo];
    if (!grupo) return;
    if (!grupo.canalTextoId || !grupo.dashboardMsgId) return;
    const canalTexto = guild.channels.cache.get(grupo.canalTextoId);
    if (!canalTexto) return;
    const msg = await canalTexto.messages.fetch(grupo.dashboardMsgId).catch(() => null);
    if (msg) await msg.edit(gerarDashboardGrupo(evento, indexGrupo)).catch(() => null);
}

function obterStatusTempoGrupo(grupo) {
    if (grupo.inicioAtivoMs) return `🟢 Ativo há ${formatarDuracaoMs(Date.now() - grupo.inicioAtivoMs)}`;
    if (!grupo.inicioPrevistoMs) return '⏳ Horário inválido';
    const faltamMs = grupo.inicioPrevistoMs - Date.now();
    if (faltamMs <= 0) return '🟡 Iniciando...';
    return `⏳ Falta ${formatarDuracaoMs(faltamMs)}`;
}

async function atualizarMensagemPrincipalEvento(guild, evento) {
    if (!evento || !evento.canalMensagemId || !evento.mensagemPrincipalId) return;
    const canalMensagem = guild.channels.cache.get(evento.canalMensagemId);
    if (!canalMensagem || !canalMensagem.messages) return;
    const msgPrincipal = await canalMensagem.messages.fetch(evento.mensagemPrincipalId).catch(() => null);
    if (!msgPrincipal) return;
    await msgPrincipal.edit(gerarInterface(evento)).catch(() => null);
}

function gerarInterface(evento) {
    const totalInscritos = evento.grupos.reduce((acc, grupo) => acc + grupo.participantes.length, 0);
    const embed = new EmbedBuilder()
        .setTitle(`⚔️ EVENTO: ${evento.nome.toUpperCase()}`)
        .setColor('#e67e22')
        .setDescription(`👑 **Líder:** <@${evento.lider}>\n${textoRequisitosBuild(evento, configuracoesPorGuild.get(evento.guildId))}\n👥 **Capacidade por Grupo:** \`${evento.totalVagas}\`\n🧾 **Inscrições Totais:** \`${totalInscritos}\`\n\n*Escolha um bloco no menu abaixo para entrar.*`)
        .setFooter({ text: `Evento ID: ${evento.id}` });

    evento.grupos.forEach((g, i) => {
        const secoes = [];
        const gerarLinha = (roleKey, emoji, label) => {
            const exigidas = evento.composicao[roleKey]; if (exigidas.length === 0) return '';
            const membros = g.participantes.filter(m => m.role === roleKey);
            const livres = getAvailableWeapons(exigidas, membros);
            return [`${emoji} **${label}** \`${membros.length}/${exigidas.length}\`  ${membros.length >= exigidas.length ? '🔴 Lotado' : '🟢 Aberto'}`, `> **Inscritos**`, membros.length ? membros.map(m => `> • <@${m.id}> com \`${m.arma}\``).join('\n') : '> • *Nenhum inscrito*', `> **Armas Livres:** ${livres.length ? `\`${livres.join(' | ')}\`` : '`Nenhuma`'}`].join('\n');
        };

        const r1 = gerarLinha('TANK', '🛡️', 'TANK'); const r2 = gerarLinha('HEALER', '💚', 'HEALER'); const r3 = gerarLinha('SUPORTE', '🔮', 'SUPORTE'); const r4 = gerarLinha('DPS', '⚔️', 'DPS MELEE'); const r5 = gerarLinha('DPS RANGER', '🏹', 'DPS RANGER');
        if (r1) secoes.push(r1); if (r2) secoes.push(r2); if (r3) secoes.push(r3); if (r4) secoes.push(r4); if (r5) secoes.push(r5);

        let desc = `${g.canalVozId ? `🎧 **Sala de Voz:** <#${g.canalVozId}>` : '🎧 **Sala de Voz:** *Abre 30 minutos antes*'}\n${g.canalTextoId ? `💬 **Canal de Texto:** <#${g.canalTextoId}>` : '💬 **Canal de Texto:** *Será criado junto da sala de voz*'}\n`;
        desc += secoes.length > 0 ? `\n${secoes.join('\n\n')}` : '\n> *Nenhuma classe configurada.*';
        desc += '\n\n────────────────────────────';
        embed.addFields({ name: `🔹 GRUPO ${i + 1} | 🕒 ${g.horario} | 👥 ${g.participantes.length}/${evento.totalVagas} | ${obterStatusTempoGrupo(g)}`, value: desc, inline: false });
    });

    const menuGrupos = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_group_${evento.id}`).setPlaceholder('Selecione o Grupo/Horário...').addOptions(evento.grupos.map((g, i) => ({ label: `Grupo ${i + 1} - ${g.horario}`, description: `Vagas: ${g.participantes.length}/${evento.totalVagas}`, value: `${i}` }))));
    const botoesAcao = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`leave_all_${evento.id}`).setLabel('Sair de Todos os Grupos').setStyle(ButtonStyle.Secondary), 
        new ButtonBuilder().setCustomId(`end_event_${evento.id}`).setLabel('Encerrar Evento Definitivo').setStyle(ButtonStyle.Danger)
    );
    return { embeds: [embed], components: [menuGrupos, botoesAcao] };
}

function limitarTexto(texto, limite = 100) {
    const valor = String(texto || '');
    return valor.length > limite ? `${valor.slice(0, limite - 3)}...` : valor;
}

const VALORES_ANULADOS_CAMPO = /^(null|nulo|n\/a|na|nenhum|none|-|—)$/i;

function campoEventoInformado(valor) {
    const texto = String(valor || '').trim();
    if (!texto || VALORES_ANULADOS_CAMPO.test(texto)) return null;
    return limitarTexto(texto, 80);
}

function normalizarIpBuild(valor) {
    const campo = campoEventoInformado(valor);
    if (!campo) return null;
    if (/^ip\s*:/i.test(campo)) return campo;
    return `IP: ${campo}`;
}

function valorCampoExibicao(valor) {
    return valor || '—';
}

function normalizarTituloBuildForum(valor) {
    const texto = String(valor || '').trim();
    if (!texto || VALORES_ANULADOS_CAMPO.test(texto)) return null;
    return limitarTexto(texto, 100);
}

function obterReferenciaForumBuilds(configGuild) {
    return configGuild?.canalForumBuildsId ? `<#${configGuild.canalForumBuildsId}>` : '*canal de fórum de builds do servidor*';
}

function textoRequisitosBuild(evento, configGuild = null) {
    const linhas = [
        `⚙️ **Tier dos Equipamentos:** \`${valorCampoExibicao(evento.tierEquipamento)}\``,
        `📊 **IP da Build:** \`${valorCampoExibicao(evento.ipBuild)}\``
    ];
    if (evento.tituloBuildForum) {
        linhas.push(`📚 **Build no fórum:** procure \`${evento.tituloBuildForum}\` em ${obterReferenciaForumBuilds(configGuild)}`);
    }
    return linhas.join('\n');
}

function gerarEmbedInstrucaoBuildParticipante(evento, configGuild, dadosInscricao = {}) {
    const { grupo, horario, role, arma } = dadosInscricao;
    const embed = new EmbedBuilder()
        .setTitle(`📚 Build do evento: ${evento.nome}`)
        .setColor('#9b59b6')
        .setDescription(
            `Você foi inscrito no evento **${evento.nome}**.\n` +
            `Confira a build correta no fórum antes da raid.`
        )
        .addFields(
            {
                name: '🔎 Título para buscar no fórum',
                value: `**\`${evento.tituloBuildForum}\`**\n*Formato padrão: Conteúdo - Numeração (ex: Baú Dourado - 01)*`,
                inline: false
            },
            {
                name: '📁 Onde procurar',
                value: obterReferenciaForumBuilds(configGuild),
                inline: false
            }
        );

    if (grupo) {
        embed.addFields({
            name: '🛡️ Sua inscrição',
            value: `**Grupo ${grupo}** — ${horario || '—'}\n**Função:** ${role || '—'} | **Arma:** ${arma || '—'}`,
            inline: false
        });
    }

    embed.addFields(
        { name: '⚙️ Tier exigido', value: `\`${valorCampoExibicao(evento.tierEquipamento)}\``, inline: true },
        { name: '📊 IP exigido', value: `\`${valorCampoExibicao(evento.ipBuild)}\``, inline: true }
    );

    return embed;
}

async function enviarDmInstrucaoBuildParticipante(userId, evento, configGuild, dadosInscricao = {}) {
    if (!evento?.tituloBuildForum) return true;
    const embed = gerarEmbedInstrucaoBuildParticipante(evento, configGuild, dadosInscricao);
    return enviarDmUsuario(userId, { embeds: [embed] });
}

function dividirTextoDiscord(texto, limite = 1024) {
    const linhas = String(texto || '').split('\n');
    const blocos = [];
    let blocoAtual = '';

    for (const linha of linhas) {
        const candidato = blocoAtual ? `${blocoAtual}\n${linha}` : linha;
        if (candidato.length <= limite) {
            blocoAtual = candidato;
            continue;
        }

        if (blocoAtual) blocos.push(blocoAtual);
        if (linha.length > limite) {
            for (let i = 0; i < linha.length; i += limite) blocos.push(linha.slice(i, i + limite));
            blocoAtual = '';
        } else {
            blocoAtual = linha;
        }
    }

    if (blocoAtual) blocos.push(blocoAtual);
    return blocos.length ? blocos : ['Sem dados.'];
}

function adicionarCampoLongo(embed, nome, texto) {
    dividirTextoDiscord(texto).forEach((bloco, index) => {
        embed.addFields({ name: index === 0 ? nome : `${nome} (${index + 1})`, value: bloco });
    });
}

function urlImagemValida(url) {
    return /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(String(url || '')) || /^https?:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/\S+/i.test(String(url || ''));
}

function textoStatusBau(grupo) {
    const bau = grupo?.bau || criarEstadoBauPadrao();
    if (bau.status === 'sem_bau') return '`Sem baú registrado`';
    if (bau.status === 'aguardando_decisao') return `\`Aguardando decisão\` — Líquido estimado: **${formatarPrata(bau.valorLiquido)}**`;
    if (bau.status === 'comprado_interno') return `\`Compra interna encerrada\` — **${formatarPrata(bau.valorPago)}** pagos por <@${bau.compradorId}>`;
    if (bau.status === STATUS_LEILAO_ABERTO) {
        const canal = bau.leilao?.channelId ? `<#${bau.leilao.channelId}>` : 'canal não localizado';
        const maiorLance = bau.leilao?.maiorLance ? ` — maior lance: **${formatarPrata(bau.leilao.maiorLance)}** por <@${bau.leilao.maiorLicitanteId}>` : '';
        return `\`PENDENTE - EM LEILÃO\` em ${canal}${maiorLance} — ${textoPrazoLeilao(bau.leilao)}`;
    }
    if (bau.status === STATUS_LEILAO_REVISAO) {
        const canal = bau.leilao?.channelId ? `<#${bau.leilao.channelId}>` : 'canal não localizado';
        const maiorLance = bau.leilao?.maiorLance ? ` — último maior lance: **${formatarPrata(bau.leilao.maiorLance)}** por <@${bau.leilao.maiorLicitanteId}>` : '';
        return `\`EM REVISÃO DO LEILÃO\` em ${canal}${maiorLance}`;
    }
    if (bau.status === STATUS_LEILAO_VENDIDO) return `\`Leilão encerrado\` — **${formatarPrata(bau.valorPago)}** por <@${bau.compradorId}>`;
    return '`Não informado`';
}

function calcularSplitValorPorTempo(grupo, valorTotal) {
    const totalMs = grupo.splitSacolas?.totalMs || grupo.participantes.reduce((acc, p) => acc + (p.totalMs || 0), 0);
    const total = Math.max(0, Math.floor(Number(valorTotal) || 0));
    if (totalMs <= 0) return { total, totalMs: 0, resultados: [] };
    return {
        total,
        totalMs,
        resultados: grupo.participantes.map(p => ({
            userId: p.id,
            tempoMs: p.totalMs || 0,
            valor: Math.floor(total * ((p.totalMs || 0) / totalMs))
        }))
    };
}

function gerarLinhasSplitSacolas(grupo) {
    const resultados = grupo.splitSacolas?.resultados || [];
    return resultados.map((resultado, index) => {
        const status = resultado.pago ? '[ ✅ PAGO ]' : '[ ⏳ PENDENTE ]';
        return `${index + 1}. ${status} <@${resultado.userId}> [${formatarDuracaoMs(resultado.tempoMs)}] ➜ **${formatarPrata(resultado.valor)}** *(+${Math.floor(resultado.xpGanho || 0)} XP)*`;
    });
}

function gerarLinhasSplitValor(splitFinal) {
    return (splitFinal?.resultados || []).map((resultado, index) => `${index + 1}. <@${resultado.userId}> [${formatarDuracaoMs(resultado.tempoMs)}] ➜ **${formatarPrata(resultado.valor)}**`);
}

function gerarEmbedRegistroEvento(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const split = grupo.splitSacolas;
    const embed = new EmbedBuilder()
        .setTitle(`⚖️ REGISTRO DO EVENTO - GRUPO ${idx + 1}`)
        .setColor(grupo.bau?.status === STATUS_LEILAO_ABERTO ? '#3498db' : grupo.bau?.status === STATUS_LEILAO_REVISAO ? '#f39c12' : '#f1c40f')
        .setDescription(
            `${textoRequisitosBuild(evento, configuracoesPorGuild.get(evento.guildId))}\n` +
            `💰 **Sacolas/Prata Bruta:** ${formatarPrata(split?.totalSacolas ?? obterSacolaTotal(grupo))}\n` +
            `⏱️ **Soma do Tempo Total da PT:** ${formatarDuracaoMs(split?.totalMs || 0)}\n` +
            `📍 **Local do loot:** ${grupo.bau?.localLoot || 'não informado'}\n` +
            `📦 **Baú:** ${textoStatusBau(grupo)}\n\n` +
            '*Os pontos de XP foram adicionados à conta de cada membro no banco de dados.*'
        );

    adicionarCampoLongo(embed, 'Checklist de Pagamentos — Sacolas', gerarLinhasSplitSacolas(grupo).join('\n') || 'Sem jogadores.');

    if (grupo.bau?.printUrl && urlImagemValida(grupo.bau.printUrl)) embed.setImage(grupo.bau.printUrl);

    if (grupo.bau?.status === 'comprado_interno' || grupo.bau?.status === STATUS_LEILAO_VENDIDO) {
        adicionarCampoLongo(embed, 'Distribuição do Baú', gerarLinhasSplitValor(grupo.bau.splitFinal).join('\n') || 'Sem distribuição registrada.');
    } else if ((grupo.bau?.status === STATUS_LEILAO_ABERTO || grupo.bau?.status === STATUS_LEILAO_REVISAO) && grupo.bau.leilao) {
        const leilao = grupo.bau.leilao;
        embed.addFields({
            name: grupo.bau.status === STATUS_LEILAO_REVISAO ? '[ 🔎 EM REVISÃO DO LEILÃO ]' : '[ ⏳ PENDENTE - EM LEILÃO ]',
            value: [
                `Canal: ${leilao.channelId ? `<#${leilao.channelId}>` : 'não localizado'}`,
                `Desconto aplicado: **${formatarPercentual(grupo.bau.descontoPercentual)}**`,
                `Lance inicial: **${formatarPrata(leilao.lanceInicial)}**`,
                leilao.maiorLance ? `Maior lance: **${formatarPrata(leilao.maiorLance)}** por <@${leilao.maiorLicitanteId}>` : 'Maior lance: nenhum lance recebido',
                textoPrazoLeilao(leilao),
                leilao.revisaoEmMs ? `Enviado para revisão: **${formatarDataHora(leilao.revisaoEmMs)}**` : null
            ].filter(Boolean).join('\n'),
            inline: false
        });
    }

    if (split?.falhasDmParticipantes?.length > 0) {
        adicionarCampoLongo(embed, '⚠️ DMs não entregues aos participantes', split.falhasDmParticipantes.map(id => `<@${id}>`).join(', '));
    }

    return embed;
}

function gerarComponentesAberturaPainelPosSplit(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dash_payment_panel_${evento.id}_${idx}`).setLabel('Painel de Pagamentos').setEmoji('✅').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dash_bau_panel_${evento.id}_${idx}`).setLabel('Gerenciar Baú').setEmoji('📦').setStyle(ButtonStyle.Secondary)
        )
    ];
}

function gerarPainelPagamentosGrupo(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const resultados = grupo?.splitSacolas?.resultados || [];
    if (!grupo?.splitSacolas) return { content: '❌ O split de sacolas ainda não foi fechado para este grupo.', components: [], ephemeral: true };

    const linhas = gerarLinhasSplitSacolas(grupo);
    const pendentes = resultados.filter(resultado => !resultado.pago).length;
    const componentes = [];
    const botoes = [];

    botoes.push(
        new ButtonBuilder()
            .setCustomId(`dash_pay_all_sacola_${evento.id}_${idx}`)
            .setLabel('Pay All')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
            .setDisabled(pendentes === 0)
    );

    resultados.slice(0, 24).forEach((resultado, index) => {
        botoes.push(
            new ButtonBuilder()
                .setCustomId(`dash_pay_sacola_${evento.id}_${idx}_${resultado.userId}`)
                .setLabel(`${resultado.pago ? 'Pago' : 'Pagar'} #${index + 1}`)
                .setStyle(resultado.pago ? ButtonStyle.Secondary : ButtonStyle.Primary)
                .setDisabled(Boolean(resultado.pago))
        );
    });

    for (let i = 0; i < botoes.length && componentes.length < 5; i += 5) {
        componentes.push(new ActionRowBuilder().addComponents(botoes.slice(i, i + 5)));
    }

    const avisoLimite = resultados.length > 24 ? '\n⚠️ A lista tem mais de 24 membros; use **Pay All** para concluir todos de uma vez.' : '';
    const resumo = dividirTextoDiscord(linhas.join('\n') || 'Sem jogadores.', 1800)[0];
    return {
        content: `👑 **Checklist de Pagamentos — Grupo ${idx + 1}**\nPendentes: **${pendentes}**\n\n${resumo}${avisoLimite}`,
        components: componentes,
        ephemeral: true
    };
}

function gerarPainelBauGrupo(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    if (!grupo?.splitSacolas) return { content: '❌ Feche primeiro o split de sacolas do grupo.', components: [], ephemeral: true };
    const bau = grupo.bau || criarEstadoBauPadrao();
    const linhas = [
        `📦 **Baú — Grupo ${idx + 1}**`,
        `Status: ${textoStatusBau(grupo)}`,
        `Local do loot: **${bau.localLoot || 'não informado'}**`,
        `Desconto do leilão: **${formatarPercentual(bau.descontoPercentual)}**`,
        `Valor bruto: **${formatarPrata(bau.valorBruto)}**`,
        `Reparo: **${formatarPrata(bau.valorReparo)}**`,
        `Líquido estimado: **${formatarPrata(bau.valorLiquido)}**`
    ];
    if (bau.printUrl) linhas.push(`Print: ${bau.printUrl}`);

    if (bau.status === 'nao_informado' || bau.status === 'sem_bau') {
        return {
            content: `${linhas.join('\n')}\n\nEnvie o print do baú neste chat e use **Usar Último Print**, ou cole o link no formulário manual.`,
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`dash_bau_ultimo_${evento.id}_${idx}`).setLabel('Usar Último Print').setEmoji('🖼️').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`dash_bau_informar_${evento.id}_${idx}`).setLabel('Informar Dados').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`dash_bau_sem_${evento.id}_${idx}`).setLabel('Sem Baú').setEmoji('🚫').setStyle(ButtonStyle.Secondary)
                )
            ],
            ephemeral: true
        };
    }

    if (bau.status === 'aguardando_decisao') {
        return {
            content: `${linhas.join('\n')}\n\nEscolha como o baú será tratado.`,
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`dash_bau_buyout_${evento.id}_${idx}`).setLabel('Compra Interna').setEmoji('🤝').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`dash_bau_leilao_${evento.id}_${idx}`).setLabel('Enviar para Leilão').setEmoji('🏷️').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`dash_bau_informar_${evento.id}_${idx}`).setLabel('Corrigir Dados').setEmoji('✏️').setStyle(ButtonStyle.Secondary)
                )
            ],
            ephemeral: true
        };
    }

    return { content: linhas.join('\n'), components: [], ephemeral: true };
}

function criarModalBau(idEvento, indexGrupo, printUrl = '') {
    const inputPrint = new TextInputBuilder()
        .setCustomId('bau_print_url')
        .setLabel('URL do print do baú')
        .setPlaceholder('Cole o link do anexo/imagem do Discord')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);
    if (printUrl) inputPrint.setValue(limitarTexto(printUrl, 4000));

    const modal = new ModalBuilder().setCustomId(`modal_bau_${idEvento}_${indexGrupo}`).setTitle('Dados do Baú');
    modal.addComponents(
        new ActionRowBuilder().addComponents(inputPrint),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bau_local').setLabel('Local onde o loot está').setPlaceholder('Ex: Brecilia, Thetford, Martlock...').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bau_valor_bruto').setLabel('Valor total estimado do loot').setPlaceholder('Ex: 5.500.000').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bau_valor_reparo').setLabel('Valor estimado do reparo').setPlaceholder('Ex: 350.000').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bau_desconto').setLabel('Desconto para lance inicial (%)').setPlaceholder('Ex: 20 para 20%').setStyle(TextInputStyle.Short).setRequired(true))
    );
    return modal;
}

function criarModalRevisaoLeilao(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const bau = evento.grupos[idx].bau || criarEstadoBauPadrao();
    const inputValorBruto = new TextInputBuilder()
        .setCustomId('bau_valor_bruto')
        .setLabel('Valor total revisado do loot')
        .setPlaceholder('Ex: 5.500.000')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    if (bau.valorBruto > 0) inputValorBruto.setValue(String(bau.valorBruto));

    const inputReparo = new TextInputBuilder()
        .setCustomId('bau_valor_reparo')
        .setLabel('Valor revisado do reparo')
        .setPlaceholder('Ex: 350.000')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    if (bau.valorReparo > 0) inputReparo.setValue(String(bau.valorReparo));

    const inputDesconto = new TextInputBuilder()
        .setCustomId('bau_desconto')
        .setLabel('Desconto revisado para lance inicial (%)')
        .setPlaceholder('Ex: 20 para 20%')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(bau.descontoPercentual ?? 20));

    const modal = new ModalBuilder().setCustomId(`modal_auction_review_${evento.id}_${idx}`).setTitle('Revisar Leilão');
    modal.addComponents(
        new ActionRowBuilder().addComponents(inputValorBruto),
        new ActionRowBuilder().addComponents(inputReparo),
        new ActionRowBuilder().addComponents(inputDesconto)
    );
    return modal;
}

function criarModalBuyoutBau(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const bau = evento.grupos[idx].bau || criarEstadoBauPadrao();
    const inputValor = new TextInputBuilder()
        .setCustomId('bau_valor_pago')
        .setLabel('Valor pago pelo baú')
        .setPlaceholder('Ex: 4.000.000')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    if (bau.valorLiquido > 0) inputValor.setValue(String(bau.valorLiquido));

    const modal = new ModalBuilder().setCustomId(`modal_bau_buyout_${evento.id}_${idx}`).setTitle('Compra Interna do Baú');
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bau_comprador').setLabel('Comprador (menção ou ID)').setPlaceholder('@Membro ou ID do membro da PT').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(inputValor)
    );
    return modal;
}

async function buscarUltimoPrintBau(channel, userId) {
    const mensagens = await channel.messages.fetch({ limit: 25 }).catch(() => null);
    if (!mensagens) return null;
    for (const mensagem of mensagens.values()) {
        if (mensagem.author?.id !== userId) continue;
        const anexo = mensagem.attachments.find(attachment => {
            const nome = attachment.name || attachment.url || '';
            return String(attachment.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(nome);
        });
        if (anexo?.url) return anexo.url;
    }
    return null;
}

function extrairUserIdTexto(texto) {
    return String(texto || '').match(/\d{15,25}/)?.[0] || null;
}

function calcularLanceInicial(valorLiquido, descontoPercentual = 20) {
    const desconto = parsePercentualDesconto(descontoPercentual, 20);
    return Math.floor(Math.max(0, Number(valorLiquido) || 0) * ((100 - desconto) / 100));
}

function gerarEmbedLeilao(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const bau = grupo.bau || criarEstadoBauPadrao();
    const leilao = bau.leilao || {};
    const maiorLanceTexto = leilao.maiorLance ? `**${formatarPrata(leilao.maiorLance)}** por <@${leilao.maiorLicitanteId}>` : '*Nenhum lance recebido ainda.*';
    const vendido = bau.status === STATUS_LEILAO_VENDIDO;
    const emRevisao = bau.status === STATUS_LEILAO_REVISAO;
    const descricao = vendido
        ? 'Este leilão foi encerrado e o split do baú já foi registrado.'
        : emRevisao
            ? 'O prazo de lances acabou. O cargo responsável pode revisar valores, ajustar desconto e reabrir o leilão.'
            : 'Use o botão **Dar Lance** para registrar uma oferta. O painel será atualizado automaticamente com o maior lance.';
    const embed = new EmbedBuilder()
        .setTitle(`🏷️ LEILÃO DE LOOT — ${evento.nome} | Grupo ${idx + 1}`)
        .setColor(vendido ? '#2ecc71' : emRevisao ? '#f39c12' : '#3498db')
        .setDescription(descricao)
        .addFields(
            { name: 'Local do loot', value: bau.localLoot || 'não informado', inline: false },
            { name: 'Valor bruto dos itens', value: formatarPrata(bau.valorBruto), inline: true },
            { name: 'Reparo estimado', value: formatarPrata(bau.valorReparo), inline: true },
            { name: 'Valor líquido estimado', value: formatarPrata(bau.valorLiquido), inline: true },
            { name: `Lance inicial (-${formatarPercentual(bau.descontoPercentual)} do líquido)`, value: `**${formatarPrata(leilao.lanceInicial || calcularLanceInicial(bau.valorLiquido, bau.descontoPercentual))}**`, inline: false },
            { name: 'Maior lance atual', value: maiorLanceTexto, inline: false },
            { name: 'Prazo', value: textoPrazoLeilao(leilao), inline: false }
        )
        .setFooter({ text: vendido ? 'Leilão encerrado.' : emRevisao ? 'Apenas responsáveis pelo leilão podem revisar ou reabrir.' : `Aberto por até ${DIAS_UTEIS_LEILAO} dias úteis. Lances abaixo do mínimo ou do maior lance atual serão recusados.` });
    if (leilao.revisaoEmMs) embed.addFields({ name: 'Revisão', value: `Enviado para revisão em **${formatarDataHora(leilao.revisaoEmMs)}**.`, inline: false });
    if (bau.printUrl && urlImagemValida(bau.printUrl)) embed.setImage(bau.printUrl);
    return embed;
}

function gerarComponentesLeilao(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const bau = grupo.bau || criarEstadoBauPadrao();
    const vendido = bau.status === STATUS_LEILAO_VENDIDO;
    const emRevisao = bau.status === STATUS_LEILAO_REVISAO;
    if (emRevisao) {
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`auction_reopen_${evento.id}_${idx}`).setLabel('Reabrir Leilão').setEmoji('🔄').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`auction_review_${evento.id}_${idx}`).setLabel('Revisar Valores').setEmoji('✏️').setStyle(ButtonStyle.Secondary)
            )
        ];
    }
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`auction_bid_${evento.id}_${idx}`).setLabel('Dar Lance').setEmoji('💰').setStyle(ButtonStyle.Primary).setDisabled(vendido),
            new ButtonBuilder().setCustomId(`auction_close_${evento.id}_${idx}`).setLabel('Encerrar Leilão').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(vendido || !bau.leilao?.maiorLance)
        )
    ];
}

async function atualizarRegistroEvento(guild, evento, indexGrupo) {
    const grupo = evento?.grupos?.[normalizarIndexGrupo(indexGrupo)];
    if (!guild || !grupo?.splitSacolas) return;
    const payload = { embeds: [gerarEmbedRegistroEvento(evento, indexGrupo)] };

    if (grupo.splitSacolas.registroChannelId && grupo.splitSacolas.registroMessageId) {
        const canalRegistro = guild.channels.cache.get(grupo.splitSacolas.registroChannelId) || await guild.channels.fetch(grupo.splitSacolas.registroChannelId).catch(() => null);
        const msgRegistro = canalRegistro?.messages ? await canalRegistro.messages.fetch(grupo.splitSacolas.registroMessageId).catch(() => null) : null;
        if (msgRegistro) await msgRegistro.edit(payload).catch(() => null);
    }

    if (grupo.splitSacolas.relatorioChannelId && grupo.splitSacolas.relatorioMessageId) {
        const canalRelatorio = guild.channels.cache.get(grupo.splitSacolas.relatorioChannelId) || await guild.channels.fetch(grupo.splitSacolas.relatorioChannelId).catch(() => null);
        const msgRelatorio = canalRelatorio?.messages ? await canalRelatorio.messages.fetch(grupo.splitSacolas.relatorioMessageId).catch(() => null) : null;
        if (msgRelatorio) await msgRelatorio.edit(payload).catch(() => null);
    }
}

function obterLeiloesAtivosUsuario(guildId, userId) {
    const leiloes = [];
    for (const [, evento] of eventosAtivos) {
        if (evento.guildId !== guildId) continue;
        evento.grupos.forEach((grupo, index) => {
            if (grupo?.bau?.status !== STATUS_LEILAO_ABERTO) return;
            if (!grupo.participantes?.some(p => p.id === userId)) return;
            leiloes.push({
                eventoNome: evento.nome,
                grupo: index + 1,
                localLoot: grupo.bau.localLoot || 'não informado',
                lanceAtual: grupo.bau.leilao?.maiorLance || grupo.bau.leilao?.lanceInicial || 0,
                channelId: grupo.bau.leilao?.channelId || null
            });
        });
    }
    return leiloes;
}

function linhasLancamentosSaldo(lancamentos, limite = 8) {
    const lista = lancamentos.slice(-limite).reverse();
    return lista.map(item => `• **${formatarPrata(item.valor)}** — ${item.descricao}`);
}

function gerarEmbedSaldo(guildId, userId) {
    const saldo = obterSaldoMembro(guildId, userId);
    const disponiveis = saldo.lancamentos.filter(item => item.status === 'disponivel' && item.valor > 0);
    const solicitados = saldo.lancamentos.filter(item => item.status === 'solicitado' && item.valor > 0);
    const pagos = saldo.lancamentos.filter(item => item.status === 'pago' && item.valor > 0);
    const leiloes = obterLeiloesAtivosUsuario(guildId, userId);
    const totalDisponivel = disponiveis.reduce((acc, item) => acc + item.valor, 0);
    const totalSolicitado = solicitados.reduce((acc, item) => acc + item.valor, 0);

    const embed = new EmbedBuilder()
        .setTitle('💼 Seu saldo de splits')
        .setColor(totalDisponivel > 0 ? '#2ecc71' : '#95a5a6')
        .setDescription(`Saldo disponível para resgate: **${formatarPrata(totalDisponivel)}**\nResgates aguardando pagamento: **${formatarPrata(totalSolicitado)}**`);

    adicionarCampoLongo(embed, 'Disponível para resgate', linhasLancamentosSaldo(disponiveis).join('\n') || 'Nada disponível no momento.');
    adicionarCampoLongo(embed, 'Pendente de pagamento', linhasLancamentosSaldo(solicitados).join('\n') || 'Nenhum resgate solicitado.');
    adicionarCampoLongo(embed, 'Em leilão', leiloes.map(item => `• ${item.eventoNome} | Grupo ${item.grupo} | ${item.localLoot} | ${item.channelId ? `<#${item.channelId}>` : 'canal não localizado'} | referência: **${formatarPrata(item.lanceAtual)}**`).join('\n') || 'Nenhum baú seu está em leilão agora.');
    adicionarCampoLongo(embed, 'Últimos pagos', linhasLancamentosSaldo(pagos, 5).join('\n') || 'Nenhum pagamento registrado.');
    return embed;
}

function gerarComponentesSaldo(guildId, userId) {
    const saldo = obterSaldoMembro(guildId, userId);
    const totalDisponivel = saldo.lancamentos
        .filter(item => item.status === 'disponivel' && item.valor > 0)
        .reduce((acc, item) => acc + item.valor, 0);
    return totalDisponivel > 0
        ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`saldo_resgate_${guildId}_${userId}`).setLabel('Solicitar Resgate').setEmoji('💸').setStyle(ButtonStyle.Success))]
        : [];
}

async function enviarDmResponsaveisLeilao(guild, configGuild, payload) {
    if (!guild || !configGuild?.cargoLeilaoId) return 0;
    const membros = guild.members.cache.filter(membro => membro.roles.cache.has(configGuild.cargoLeilaoId) && !membro.user.bot);

    let enviados = 0;
    for (const membro of membros.values()) {
        const enviado = await enviarDmUsuario(membro.id, payload);
        if (enviado) enviados++;
    }
    return enviados;
}

async function atualizarMensagemLeilao(guild, evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const leilao = evento?.grupos?.[idx]?.bau?.leilao;
    if (!guild || !evento || !leilao?.channelId || !leilao?.messageId) return { canal: null, mensagem: null };

    const canal = guild.channels.cache.get(leilao.channelId) || await guild.channels.fetch(leilao.channelId).catch(() => null);
    const mensagem = canal?.messages ? await canal.messages.fetch(leilao.messageId).catch(() => null) : null;
    if (mensagem) {
        await mensagem.edit({
            embeds: [gerarEmbedLeilao(evento, idx)],
            components: gerarComponentesLeilao(evento, idx)
        }).catch(() => null);
    }
    return { canal, mensagem };
}

async function enviarLeilaoParaRevisao(guild, evento, indexGrupo, motivo = 'prazo_expirado') {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento?.grupos?.[idx];
    const bau = grupo?.bau;
    const leilao = bau?.leilao;
    if (!guild || !evento || bau?.status !== STATUS_LEILAO_ABERTO || !leilao) return false;
    if (motivo === 'prazo_expirado' && !leilaoPrazoExpirado(leilao)) return false;

    bau.status = STATUS_LEILAO_REVISAO;
    leilao.revisaoEmMs = Date.now();
    leilao.revisaoMotivo = motivo;
    leilao.revisaoNotificadaEmMs = Date.now();
    salvarDados();

    const { canal } = await atualizarMensagemLeilao(guild, evento, idx);
    const configGuild = configuracoesPorGuild.get(evento.guildId);
    const embed = new EmbedBuilder()
        .setTitle('🔎 Leilão enviado para revisão')
        .setColor('#f39c12')
        .setDescription(`O leilão do **${evento.nome} — Grupo ${idx + 1}** chegou ao limite de **${DIAS_UTEIS_LEILAO} dias úteis**.`)
        .addFields(
            { name: 'Canal', value: leilao.channelId ? `<#${leilao.channelId}>` : 'não localizado', inline: true },
            { name: 'Último maior lance', value: leilao.maiorLance ? `${formatarPrata(leilao.maiorLance)} por <@${leilao.maiorLicitanteId}>` : 'Nenhum lance recebido', inline: false },
            { name: 'Próxima ação', value: 'Revise valores/desconto e reabra o leilão quando estiver pronto.', inline: false }
        );

    if (canal?.send) {
        await canal.send({
            content: configGuild?.cargoLeilaoId ? `<@&${configGuild.cargoLeilaoId}> leilão aguardando revisão.` : 'Leilão aguardando revisão.',
            embeds: [embed],
            allowedMentions: configGuild?.cargoLeilaoId ? { roles: [configGuild.cargoLeilaoId] } : undefined
        }).catch(() => null);
    }

    await enviarDmResponsaveisLeilao(guild, configGuild, { embeds: [embed] });
    await atualizarRegistroEvento(guild, evento, idx);
    salvarDados();
    return true;
}

async function solicitarResgateSaldo(interaction, guildId, userId) {
    if (interaction.user.id !== userId) {
        return interaction.reply({ content: '❌ Você só pode solicitar resgate do seu próprio saldo.', ephemeral: true });
    }

    const guild = interaction.guild || client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const configGuild = configuracoesPorGuild.get(guildId);
    if (!configGuild?.cargoLeilaoId) {
        return interaction.reply({ content: '❌ O cargo responsável por leilões/resgates ainda não foi configurado em /configuracoes.', ephemeral: true });
    }

    const saldo = obterSaldoMembro(guildId, userId);
    const disponiveis = saldo.lancamentos.filter(item => item.status === 'disponivel' && item.valor > 0);
    if (disponiveis.length === 0) {
        return interaction.update({ embeds: [gerarEmbedSaldo(guildId, userId)], components: gerarComponentesSaldo(guildId, userId) });
    }
    await interaction.deferUpdate();

    const resgateId = Date.now().toString();
    const valorTotal = disponiveis.reduce((acc, item) => acc + item.valor, 0);
    disponiveis.forEach(item => {
        item.status = 'solicitado';
        item.solicitadoEmMs = Date.now();
        item.resgateId = resgateId;
    });
    saldo.resgates.push({
        id: resgateId,
        valorTotal,
        status: 'solicitado',
        solicitadoEmMs: Date.now(),
        pagoEmMs: null,
        pagoPorId: null,
        lancamentoIds: disponiveis.map(item => item.id)
    });
    salvarDados();

    const embedPedido = new EmbedBuilder()
        .setTitle('💸 Solicitação de resgate')
        .setColor('#f1c40f')
        .setDescription(`<@${userId}> solicitou resgate de **${formatarPrata(valorTotal)}**.`)
        .addFields({ name: 'Itens incluídos', value: dividirTextoDiscord(disponiveis.map(item => `• ${item.descricao}: **${formatarPrata(item.valor)}**`).join('\n'), 1024)[0] })
        .setFooter({ text: `Resgate ID: ${resgateId}` });
    const componentes = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`saldo_pagar_${guildId}_${userId}_${resgateId}`).setLabel('Marcar como Pago').setEmoji('✅').setStyle(ButtonStyle.Success))];

    if (interaction.channel?.send) {
        await interaction.channel.send({
            content: `<@&${configGuild.cargoLeilaoId}> novo resgate solicitado por <@${userId}>.`,
            embeds: [embedPedido],
            components: componentes,
            allowedMentions: { roles: [configGuild.cargoLeilaoId], users: [userId] }
        }).catch(() => null);
    }

    const dmsEnviadas = await enviarDmResponsaveisLeilao(guild, configGuild, { embeds: [embedPedido], components: componentes });
    await enviarDmUsuario(userId, { embeds: [new EmbedBuilder().setTitle('✅ Resgate solicitado').setColor('#2ecc71').setDescription(`Seu pedido de **${formatarPrata(valorTotal)}** foi enviado para o cargo responsável.`)] });

    return interaction.editReply({
        content: `✅ Resgate solicitado. DMs enviadas aos responsáveis: **${dmsEnviadas}**.`,
        embeds: [gerarEmbedSaldo(guildId, userId)],
        components: gerarComponentesSaldo(guildId, userId)
    });
}

async function marcarResgateComoPago(interaction, guildId, userId, resgateId) {
    const guild = interaction.guild || client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const podeOperar = await usuarioPodeOperarLeilao(interaction, guildId);
    if (!podeOperar) return interaction.reply({ content: '❌ Apenas o cargo responsável por leilões/resgates pode marcar este resgate como pago.', ephemeral: true });

    const saldo = obterSaldoMembro(guildId, userId);
    const resgate = saldo.resgates.find(item => item.id === resgateId);
    if (!resgate) return interaction.reply({ content: '❌ Resgate não encontrado.', ephemeral: true });
    if (resgate.status === 'pago') return interaction.reply({ content: '✅ Este resgate já estava marcado como pago.', ephemeral: true });
    await interaction.deferUpdate();

    resgate.status = 'pago';
    resgate.pagoEmMs = Date.now();
    resgate.pagoPorId = interaction.user.id;

    const eventosParaAtualizar = new Set();
    saldo.lancamentos.forEach(lancamento => {
        if (lancamento.resgateId !== resgateId) return;
        lancamento.status = 'pago';
        lancamento.pagoEmMs = Date.now();
        lancamento.pagoPorId = interaction.user.id;
        if (lancamento.tipo === 'sacolas' && lancamento.eventoId) {
            const evento = eventosAtivos.get(lancamento.eventoId);
            const grupo = evento?.grupos?.[normalizarIndexGrupo(lancamento.grupoIndex)];
            const resultado = grupo?.splitSacolas?.resultados?.find(item => item.userId === userId);
            if (resultado) {
                resultado.pago = true;
                resultado.pagoEmMs = Date.now();
                resultado.pagoPorId = interaction.user.id;
                eventosParaAtualizar.add(`${lancamento.eventoId}_${normalizarIndexGrupo(lancamento.grupoIndex)}`);
            }
        }
    });

    salvarDados();
    for (const chave of eventosParaAtualizar) {
        const [eventoId, grupoIndex] = chave.split('_');
        const evento = eventosAtivos.get(eventoId);
        if (evento && guild) await atualizarRegistroEvento(guild, evento, grupoIndex);
    }

    await enviarDmUsuario(userId, { embeds: [new EmbedBuilder().setTitle('✅ Resgate pago').setColor('#2ecc71').setDescription(`Seu resgate de **${formatarPrata(resgate.valorTotal)}** foi marcado como pago por <@${interaction.user.id}>.`)] });
    const resposta = { content: `✅ Resgate de <@${userId}> marcado como pago: **${formatarPrata(resgate.valorTotal)}**.`, components: [] };
    return interaction.editReply(resposta);
}

function gerarMenuRoles(idEvento, indexGrupo) {
    const evento = eventosAtivos.get(idEvento); const grupo = evento?.grupos[indexGrupo]; const options = [];
    if (!evento || !grupo || grupo.fechado) {
        options.push({ label: 'Evento indisponível', value: 'UNAVAILABLE' });
        return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_role_${idEvento}_${indexGrupo}`).setPlaceholder('Escolha sua função...').addOptions(options));
    }
    const verificarVaga = (label, roleKey) => { if (evento.composicao[roleKey].length > 0 && grupo.participantes.filter(p => p.role === roleKey).length < evento.composicao[roleKey].length) options.push({ label: label, value: roleParaSlug(roleKey) }); };
    verificarVaga('🛡️ Tank', 'TANK'); verificarVaga('💚 Healer', 'HEALER'); verificarVaga('🔮 Suporte', 'SUPORTE'); verificarVaga('⚔️ DPS Melee', 'DPS'); verificarVaga('🏹 DPS Ranger', 'DPS RANGER');
    if (options.length === 0) options.push({ label: 'Grupo Totalmente Lotado', value: 'FULL' });
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_role_${idEvento}_${indexGrupo}`).setPlaceholder('Escolha sua função...').addOptions(options));
}

function gerarMenuArmas(idEvento, indexGrupo, role) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const roleSlug = roleParaSlug(role);
    const evento = eventosAtivos.get(idEvento); const grupo = evento?.grupos[idx];
    if (!evento || !grupo || grupo.fechado || !evento.composicao[role]) {
        return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_weapon_${idEvento}_${idx}_${roleSlug}`).setPlaceholder('Escolha sua arma...').addOptions([{ label: 'Evento indisponível', value: 'UNAVAILABLE' }]));
    }
    const disponiveis = getAvailableWeapons(evento.composicao[role], grupo.participantes.filter(p => p.role === role));
    const contagem = {}; disponiveis.forEach(arma => contagem[arma] = (contagem[arma] || 0) + 1);
    const options = Object.keys(contagem).slice(0, MAX_OPCOES_MENU).map(arma => ({ label: limitarTexto(`${arma} (${contagem[arma]} vaga${contagem[arma] > 1 ? 's' : ''})`), value: limitarTexto(arma) }));
    if (options.length === 0) options.push({ label: 'Nenhuma arma disponível', value: 'UNAVAILABLE' });
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_weapon_${idEvento}_${idx}_${roleSlug}`).setPlaceholder('Escolha sua arma...').addOptions(options));
}

async function abrirSalaGrupo(guild, evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const permissionOverwritesVoz = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }];
    const permissionOverwritesTexto = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }];

    for (const p of grupo.participantes) {
        permissionOverwritesVoz.push({ id: p.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
        permissionOverwritesTexto.push({ id: p.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        p.lastStartMs = null; p.isPaused = false;
    }

    const categoriaValida = evento.categoriaId && guild.channels.cache.get(evento.categoriaId) && guild.channels.cache.get(evento.categoriaId).type === ChannelType.GuildCategory;
    const nomeSala = await gerarNomeSalaGrupo(guild, evento, idx);

    let canalVoz = await guild.channels.create({ name: nomeSala, type: ChannelType.GuildVoice, parent: categoriaValida ? evento.categoriaId : undefined, permissionOverwrites: permissionOverwritesVoz });
    grupo.canalVozId = canalVoz.id;

    let canalTexto;
    try {
        canalTexto = await guild.channels.create({ name: nomeSala, type: ChannelType.GuildText, parent: categoriaValida ? evento.categoriaId : undefined, permissionOverwrites: permissionOverwritesTexto });
    } catch (error) {
        canalTexto = await guild.channels.create({ name: criarSlug(nomeSala, 'grupo').slice(0, 95), type: ChannelType.GuildText, parent: categoriaValida ? evento.categoriaId : undefined, permissionOverwrites: permissionOverwritesTexto });
    }
    grupo.canalTextoId = canalTexto.id;

    const dashMsg = await canalTexto.send(gerarDashboardGrupo(evento, idx));
    grupo.dashboardMsgId = dashMsg.id;
    salvarDados();
    return { canalVoz, canalTexto };
}

async function enviarDmUsuario(userId, payload) {
    try {
        const user = await client.users.fetch(userId);
        await user.send(payload);
        return true;
    } catch (err) {
        console.log(`Não foi possível enviar DM para o ID ${userId}: ${err.message}`);
        return false;
    }
}

function gerarEmbedRegistroPreRaid(evento, indexGrupo) {
    const idx = normalizarIndexGrupo(indexGrupo);
    const grupo = evento.grupos[idx];
    const embed = new EmbedBuilder()
        .setTitle(`📋 Registro do Grupo ${idx + 1}: ${evento.nome}`)
        .setColor('#9b59b6')
        .setDescription(`Resumo atual da composição para o bloco das **${grupo.horario}**.\n${textoRequisitosBuild(evento, configuracoesPorGuild.get(evento.guildId))}`);

    const participantesTexto = grupo.participantes.length
        ? grupo.participantes.map(p => `<@${p.id}> — **${p.role}** [${p.arma}]`).join('\n')
        : '*Nenhum participante registrado até agora.*';

    const roles = [
        ['TANK', '🛡️', 'TANK'],
        ['HEALER', '💚', 'HEALER'],
        ['SUPORTE', '🔮', 'SUPORTE'],
        ['DPS', '⚔️', 'DPS MELEE'],
        ['DPS RANGER', '🏹', 'DPS RANGER']
    ];

    const vagasTexto = roles.map(([roleKey, emoji, label]) => {
        const exigidas = evento.composicao[roleKey] || [];
        if (exigidas.length === 0) return '';
        const membros = grupo.participantes.filter(p => p.role === roleKey);
        const livres = getAvailableWeapons(exigidas, membros);
        if (livres.length === 0) return `${emoji} **${label}:** ✅ preenchido`;
        return `${emoji} **${label}:** ${livres.map(arma => `\`${arma}\``).join(', ')}`;
    }).filter(Boolean).join('\n') || '✅ Todas as vagas configuradas foram preenchidas.';

    adicionarCampoLongo(embed, '👥 Participantes registrados', participantesTexto);
    adicionarCampoLongo(embed, '🧩 Vagas ainda abertas', vagasTexto);
    return embed;
}

function deveDispararAlertaGrupo(grupo) {
    if (!grupo?.inicioPrevistoMs || grupo.notificado) return false;
    return Date.now() >= grupo.inicioPrevistoMs - (MINUTOS_ABERTURA_SALA * 60 * 1000);
}

async function notificarPreRaidGrupo(guild, evento, indexGrupo) {
    const grupo = evento.grupos[indexGrupo];
    if (!grupo || grupo.notificado) return [];

    const destinatariosParticipantes = new Set(grupo.participantes.map(p => p.id).filter(id => id !== evento.lider));

    const embed = new EmbedBuilder()
        .setTitle(`⏰ Raid em ${MINUTOS_ABERTURA_SALA} minutos: ${evento.nome}`)
        .setColor('#3498db')
        .setDescription(`O **Grupo ${normalizarIndexGrupo(indexGrupo) + 1}** começa às **${grupo.horario}**.\nAs salas já foram abertas para os participantes registrados.`)
        .addFields(
            { name: '📚 Build no fórum', value: evento.tituloBuildForum ? `\`${evento.tituloBuildForum}\`` : '—', inline: false },
            { name: '⚙️ Tier', value: `\`${valorCampoExibicao(evento.tierEquipamento)}\``, inline: true },
            { name: '📊 IP', value: `\`${valorCampoExibicao(evento.ipBuild)}\``, inline: true },
            { name: '🎧 Sala de Voz', value: grupo.canalVozId ? `<#${grupo.canalVozId}>` : '*Ainda não criada*', inline: true },
            { name: '💬 Chat da PT', value: grupo.canalTextoId ? `<#${grupo.canalTextoId}>` : '*Ainda não criado*', inline: true },
            { name: '👥 Participantes', value: `${grupo.participantes.length}/${evento.totalVagas}`, inline: true }
        )
        .setFooter({ text: 'Entre na sala de voz para o cronômetro começar a contar seu tempo ativo.' });

    const falhas = [];
    for (const userId of destinatariosParticipantes) {
        const enviado = await enviarDmUsuario(userId, { embeds: [embed] });
        if (!enviado) falhas.push(userId);
    }

    const embedRegistroLider = gerarEmbedRegistroPreRaid(evento, indexGrupo);
    const dmLiderEnviada = await enviarDmUsuario(evento.lider, { embeds: [embed, embedRegistroLider] });
    if (!dmLiderEnviada) falhas.push(evento.lider);

    grupo.notificado = true;
    salvarDados();
    if (falhas.length > 0) console.log(`Falha ao enviar alerta pré-raid para: ${falhas.join(', ')}`);
    return falhas;
}

async function excluirCanalRegistro(registro) {
    try {
        if (registro.apagarEmMs && Date.now() < registro.apagarEmMs) {
            agendarExclusaoCanalRegistro(registro);
            return;
        }
        const guild = client.guilds.cache.get(registro.guildId) || await client.guilds.fetch(registro.guildId).catch(() => null);
        const canal = guild ? (guild.channels.cache.get(registro.channelId) || await guild.channels.fetch(registro.channelId).catch(() => null)) : null;
        if (canal) await canal.delete('Registro temporário expirado.').catch(() => null);
    } catch (error) {
        console.error('Erro ao excluir canal temporário de registro:', error);
    } finally {
        registrosCanais.delete(registro.channelId);
        salvarDados();
    }
}

function agendarExclusaoCanalRegistro(registro) {
    const delay = registro.apagarEmMs - Date.now();
    const executar = () => excluirCanalRegistro(registro).catch(() => null);
    if (delay <= 0) executar();
    else setTimeout(executar, Math.min(delay, 2147483647));
}

function agendarRegistrosSalvos() {
    for (const registro of registrosCanais.values()) agendarExclusaoCanalRegistro(registro);
}

async function estenderRetencaoRegistroLeilao(guild, grupo) {
    const channelId = grupo?.splitSacolas?.registroChannelId;
    if (!channelId) return false;
    const registro = registrosCanais.get(channelId);
    if (!registro) return false;
    registro.apagarEmMs = Math.max(registro.apagarEmMs || 0, Date.now() + TEMPO_RETENCAO_REGISTROS_LEILAO_MS);
    registro.retencaoEstendidaLeilao = true;
    const canal = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (canal?.setTopic) {
        await canal.setTopic(`Registro temporário estendido por leilão aberto. Apaga automaticamente em até ${DIAS_RETENCAO_REGISTROS_LEILAO} dias.`).catch(() => null);
    }
    salvarDados();
    agendarExclusaoCanalRegistro(registro);
    return true;
}

async function criarCanalRegistroSplit(guild, evento, indexGrupo, embedSplit, configGuild) {
    if (!configGuild?.categoriaRegistrosId) return { criado: false, motivo: 'categoria_nao_configurada' };

    const categoria = guild.channels.cache.get(configGuild.categoriaRegistrosId) || await guild.channels.fetch(configGuild.categoriaRegistrosId).catch(() => null);
    if (!categoria || categoria.type !== ChannelType.GuildCategory) return { criado: false, motivo: 'categoria_invalida' };

    const apagarEmMs = Date.now() + TEMPO_RETENCAO_REGISTROS_MS;
    const slugEvento = criarSlug(evento.nome);
    const nomeCanal = `registro-g${parseInt(indexGrupo, 10) + 1}-${slugEvento}`.slice(0, 95);
    const canalRegistro = await guild.channels.create({
        name: nomeCanal,
        type: ChannelType.GuildText,
        parent: categoria.id,
        topic: `Registro temporário do evento ${evento.nome}. Apaga automaticamente em ${DIAS_RETENCAO_REGISTROS} dias.`
    });

    const mensagemRegistro = await canalRegistro.send({
        content: `📌 Registro temporário do split. Este canal será apagado automaticamente em **${DIAS_RETENCAO_REGISTROS} dias**.`,
        embeds: [embedSplit]
    });

    const registro = {
        guildId: guild.id,
        channelId: canalRegistro.id,
        eventoId: evento.id,
        nomeEvento: evento.nome,
        grupo: parseInt(indexGrupo, 10) + 1,
        criadoEmMs: Date.now(),
        apagarEmMs
    };

    registrosCanais.set(canalRegistro.id, registro);
    salvarDados();
    agendarExclusaoCanalRegistro(registro);
    return { criado: true, canalId: canalRegistro.id, messageId: mensagemRegistro.id };
}

function gerarEmbedEventoEncerrado(userId, detalhe = 'Todas as salas vinculadas a este evento foram apagadas e os dados foram salvos.') {
    return new EmbedBuilder()
        .setTitle(`✅ EVENTO ENCERRADO DEFINITIVAMENTE`)
        .setColor('#7f8c8d')
        .setDescription(`Encerrado por <@${userId}>.\n${detalhe}`);
}

async function encerrarMensagemEventoSemMemoria(interaction, idEvento = null) {
    const idsCanais = new Set();
    interaction.message?.embeds?.forEach(embed => {
        const textos = [embed.description, ...(embed.fields || []).map(field => `${field.name}\n${field.value}`)].filter(Boolean);
        textos.forEach(texto => {
            const matches = String(texto).matchAll(/<#(\d+)>/g);
            for (const match of matches) idsCanais.add(match[1]);
        });
    });

    for (const channelId of idsCanais) {
        const canal = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (canal && canal.deletable) await canal.delete('Evento encerrado (mensagem antiga ou após reinício do bot).').catch(() => null);
    }

    if (idEvento) removerEventoPersistido(idEvento);

    const detalhe = idsCanais.size > 0
        ? `A mensagem foi encerrada e ${idsCanais.size} canal(is) vinculado(s) foram removidos quando possível.`
        : 'A mensagem foi encerrada e os botões foram removidos.';

    await interaction.update({ embeds: [gerarEmbedEventoEncerrado(interaction.user.id, detalhe)], components: [] });
}

function usuarioPodeEncerrarMensagemAntiga(interaction, idEvento = null) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) return true;
    const autorMensagem = interaction.message?.interactionMetadata?.user?.id || interaction.message?.interaction?.user?.id;
    if (autorMensagem && autorMensagem === interaction.user.id) return true;
    const descricao = interaction.message?.embeds?.[0]?.description || '';
    const liderId = descricao.match(/Líder:\*\*\s*<@!?(\d+)>/)?.[1];
    if (liderId && liderId === interaction.user.id) return true;
    if (idEvento) {
        const evento = obterEvento(idEvento, interaction);
        if (evento && (interaction.user.id === evento.lider || interaction.user.id === evento.criadoPorId)) return true;
    }
    return false;
}

function eventoTemLeilaoAberto(evento) {
    return Boolean(evento?.grupos?.some(grupo => grupo?.bau?.status === STATUS_LEILAO_ABERTO || grupo?.bau?.status === STATUS_LEILAO_REVISAO));
}

// ==========================================
// COMANDOS DE BARRA (SLASH COMMANDS)
// ==========================================
const comandoEvento = new SlashCommandBuilder()
    .setName('evento')
    .setDescription('Cria evento com Split, Tier/IP da build e XP por hora')
    .addStringOption(opt => opt.setName('nome').setDescription('Nome da Raid/Evento').setRequired(true))
    .addUserOption(opt => opt.setName('lider').setDescription('Líder do evento').setRequired(true))
    .addStringOption(opt => opt.setName('tier_equipamento').setDescription('Tier: 4.1-4.2 ou null se usar só IP').setRequired(true))
    .addStringOption(opt => opt.setName('ip_build').setDescription('IP: 1450 ou null se usar só Tier').setRequired(true))
    .addStringOption(opt => opt.setName('horarios').setDescription('Ex: 13:00, 14:00...').setRequired(true))
    .addStringOption(opt => opt.setName('titulo_build').setDescription('Título no fórum de builds. Ex: Baú Dourado - 01').setRequired(true))
    .addStringOption(opt => opt.setName('armas_tank').setDescription('Ex: Maça, Fura-Bruma3').setRequired(false))
    .addStringOption(opt => opt.setName('armas_healer').setDescription('Ex: Sagrado, Natureza2').setRequired(false))
    .addStringOption(opt => opt.setName('armas_suporte').setDescription('Ex: Chama-sombra').setRequired(false))
    .addStringOption(opt => opt.setName('armas_dps').setDescription('Ex: Espada, Machado2').setRequired(false))
    .addStringOption(opt => opt.setName('armas_ranger').setDescription('Ex: Arco*3, Cajado').setRequired(false));

const comandoConfiguracoes = new SlashCommandBuilder()
    .setName('configuracoes')
    .setDescription('Configura categoria dos canais e cargo permitido')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('categoria_canais').setDescription('Categoria').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .addRoleOption(opt => opt.setName('cargo_evento').setDescription('Cargo permitido').setRequired(true))
    .addChannelOption(opt => opt.setName('categoria_registros').setDescription('Categoria onde os relatórios finais temporários serão guardados').addChannelTypes(ChannelType.GuildCategory).setRequired(false))
    .addChannelOption(opt => opt.setName('categoria_leiloes').setDescription('Categoria onde os canais temporários de leilão serão criados').addChannelTypes(ChannelType.GuildCategory).setRequired(false))
    .addRoleOption(opt => opt.setName('cargo_leiloes').setDescription('Cargo responsável por vendas, leilões e resgates').setRequired(false))
    .addChannelOption(opt => opt.setName('canal_forum_builds').setDescription('Canal fórum das builds (Conteúdo - 01, Baú Dourado - 01...)').addChannelTypes(ChannelType.GuildForum).setRequired(false));

const comandoRanking = new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('Mostra o Top 10 membros com mais XP de atividade no mês');

const comandoSaldo = new SlashCommandBuilder()
    .setName('saldo')
    .setDescription('Consulta seus splits, leilões pendentes e saldo disponível para resgate');

const COMANDOS_SLASH_JSON = [
    comandoEvento.toJSON(),
    comandoConfiguracoes.toJSON(),
    comandoRanking.toJSON(),
    comandoSaldo.toJSON()
];

async function registrarComandosSlash(rest, guildIds = []) {
    const opcoesEvento = (comandoEvento.toJSON().options || []).map(opt => opt.name);
    console.log(`📋 Opções do /evento (${opcoesEvento.length}): ${opcoesEvento.join(', ')}`);

    if (!opcoesEvento.includes('tier_equipamento') || !opcoesEvento.includes('ip_build') || !opcoesEvento.includes('titulo_build')) {
        throw new Error('Definição do comando /evento inválida: faltam tier_equipamento, ip_build ou titulo_build');
    }

    const idsServidores = new Set(guildIds);
    if (GUILD_ID) idsServidores.add(GUILD_ID);

    for (const guildId of idsServidores) {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: COMANDOS_SLASH_JSON });
        console.log(`✅ Comandos do servidor ${guildId} atualizados (Tier e IP visíveis agora)`);
    }

    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: COMANDOS_SLASH_JSON });
    console.log(idsServidores.size > 0
        ? '✅ Comandos globais sincronizados'
        : '⚠️ Defina GUILD_ID no .env ou adicione o bot a um servidor para atualização imediata');
}

// ==========================================
// INICIALIZAÇÃO E CRON JOB
// ==========================================
client.once('ready', async () => {
    console.log(`🤖 Bot online como ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await registrarComandosSlash(rest, [...client.guilds.cache.keys()]);
        console.log('✅ Sistema completo carregado!');
    } catch (error) {
        console.error('❌ Falha ao registrar comandos — Tier/IP não aparecerão no Discord:', error);
        process.exit(1);
    }

    agendarRegistrosSalvos();

    new cron.CronJob('* * * * *', async () => {
        for (const [idEvento, evento] of eventosAtivos) {
            const guild = client.guilds.cache.get(evento.guildId); if (!guild) continue;
            for (let i = 0; i < evento.grupos.length; i++) {
                const grupo = evento.grupos[i];
                if (grupo?.bau?.status === STATUS_LEILAO_ABERTO && leilaoPrazoExpirado(grupo.bau.leilao)) {
                    await enviarLeilaoParaRevisao(guild, evento, i);
                }
                if (evento.encerradoDefinitivo) continue;
                sincronizarCronometrosGrupo(guild, grupo);
                if (!grupo.inicioAtivoMs && grupo.inicioPrevistoMs && Date.now() >= grupo.inicioPrevistoMs) {
                    grupo.inicioAtivoMs = grupo.inicioPrevistoMs;
                    if (!evento.inicioAtivoMs) evento.inicioAtivoMs = grupo.inicioAtivoMs;
                    salvarDados();
                }
                if (deveAbrirSalaGrupo(grupo)) { try { await abrirSalaGrupo(guild, evento, i); } catch (e) { console.error('Erro ao abrir sala do grupo:', e); } }
                if (deveDispararAlertaGrupo(grupo) && grupo.canalVozId && grupo.canalTextoId) await notificarPreRaidGrupo(guild, evento, i);
                if (grupo.dashboardMsgId) await atualizarMsgDashboard(guild, evento, i);
            }
            if (!evento.encerradoDefinitivo) await atualizarMensagemPrincipalEvento(guild, evento);
        }
    }).start();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const guild = newState.guild || oldState.guild;
        const userId = newState.id || oldState.id;
        if (!guild || !userId) return;

        for (const [, evento] of eventosAtivos) {
            if (evento.guildId !== guild.id) continue;

            for (let i = 0; i < evento.grupos.length; i++) {
                const grupo = evento.grupos[i];
                if (!grupo.canalVozId || grupo.fechado) continue;

                const entrouNaSala = newState.channelId === grupo.canalVozId;
                const saiuDaSala = oldState.channelId === grupo.canalVozId && newState.channelId !== grupo.canalVozId;
                if (!entrouNaSala && !saiuDaSala) continue;

                const participante = grupo.participantes.find(p => p.id === userId);
                if (!participante) continue;

                if (saiuDaSala || entrouNaSala) sincronizarParticipanteSeElegivel(guild, grupo, participante);

                await atualizarMsgDashboard(guild, evento, i);
                salvarDados();
            }
        }
    } catch (error) {
        console.error('Erro ao processar estado de voz:', error);
    }
});

// ==========================================
// INTERAÇÕES PRINCIPAIS E BOTÕES
// ==========================================
client.on('interactionCreate', async interaction => {
    try {

    // COMANDO /RANKING
    if (interaction.isChatInputCommand() && interaction.commandName === 'ranking') {
        const guildId = interaction.guild.id;
        const anoMesAtual = obterAnoMes();
        const prefixoXpMensal = `${guildId}_${anoMesAtual}_`;
        const listaRankeada = Array.from(xpMembros.entries())
            .filter(([chave]) => chave.startsWith(prefixoXpMensal))
            .map(([chave, xp]) => ({ userId: chave.slice(prefixoXpMensal.length), xp }))
            .sort((a, b) => b.xp - a.xp);

        const embedRank = new EmbedBuilder()
            .setTitle(`🏆 RANKING MENSAL DE ATIVIDADE — ${interaction.guild.name.toUpperCase()} (${anoMesAtual})`)
            .setColor('#f1c40f')
            .setDescription('Acompanhe o Top 10 membros que mais acumularam horas em Raids neste mês.\n*Lembrando: 1 hora de jogo ativa = 50 XP!* \n\n━━━━🎁 **PREMIAÇÃO TOP 3** 🎁━━━━');

        let corpoRanking = '';
        if (listaRankeada.length === 0) {
            corpoRanking = '*Nenhum jogador registrou XP neste servidor ainda.*';
        } else {
            listaRankeada.slice(0, 10).forEach((item, index) => {
                let medalha = `\`#${index + 1}\``;
                if (index === 0) medalha = '🥇 **TOP 1**';
                if (index === 1) medalha = '🥈 **TOP 2**';
                if (index === 2) medalha = '🥉 **TOP 3**';
                const horasEstimadas = (item.xp / 50).toFixed(1);
                corpoRanking += `${medalha} ➜ <@${item.userId}> — **${Math.floor(item.xp)} XP** *(~${horasEstimadas}h em Raid)*\n`;
            });
        }
        embedRank.addFields({ name: 'Placar de Líderes', value: corpoRanking });
        return interaction.reply({ embeds: [embedRank] });
    }

    // COMANDO /SALDO
    if (interaction.isChatInputCommand() && interaction.commandName === 'saldo') {
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        return interaction.reply({
            embeds: [gerarEmbedSaldo(guildId, userId)],
            components: gerarComponentesSaldo(guildId, userId),
            ephemeral: true
        });
    }

    // COMANDO /CONFIGURACOES
    if (interaction.isChatInputCommand() && interaction.commandName === 'configuracoes') {
        const categoria = interaction.options.getChannel('categoria_canais');
        const cargoEvento = interaction.options.getRole('cargo_evento');
        const categoriaRegistros = interaction.options.getChannel('categoria_registros');
        const categoriaLeiloes = interaction.options.getChannel('categoria_leiloes');
        const cargoLeiloes = interaction.options.getRole('cargo_leiloes');
        const canalForumBuilds = interaction.options.getChannel('canal_forum_builds');
        const configAtual = configuracoesPorGuild.get(interaction.guild.id) || {};
        configuracoesPorGuild.set(interaction.guild.id, {
            categoriaId: categoria.id,
            cargoEventoId: cargoEvento.id,
            categoriaRegistrosId: categoriaRegistros?.id || configAtual.categoriaRegistrosId || null,
            categoriaLeiloesId: categoriaLeiloes?.id || configAtual.categoriaLeiloesId || null,
            cargoLeilaoId: cargoLeiloes?.id || configAtual.cargoLeilaoId || null,
            canalForumBuildsId: canalForumBuilds?.id || configAtual.canalForumBuildsId || null,
            atualizadoPorId: interaction.user.id
        });
        salvarDados();
        const textoRegistros = categoriaRegistros
            ? `\n📁 Categoria de registros: <#${categoriaRegistros.id}>`
            : (configAtual.categoriaRegistrosId ? `\n📁 Categoria de registros mantida: <#${configAtual.categoriaRegistrosId}>` : '\n📁 Categoria de registros: não configurada');
        const textoForum = canalForumBuilds
            ? `\n📚 Fórum de builds: <#${canalForumBuilds.id}>`
            : (configAtual.canalForumBuildsId ? `\n📚 Fórum de builds mantido: <#${configAtual.canalForumBuildsId}>` : '\n📚 Fórum de builds: não configurado (configure para link na DM)');
        const textoLeiloes = categoriaLeiloes
            ? `\n🏷️ Categoria de leilões: <#${categoriaLeiloes.id}>`
            : (configAtual.categoriaLeiloesId ? `\n🏷️ Categoria de leilões mantida: <#${configAtual.categoriaLeiloesId}>` : '\n🏷️ Categoria de leilões: não configurada');
        const textoCargoLeiloes = cargoLeiloes
            ? `\n🧾 Cargo responsável por leilões/resgates: <@&${cargoLeiloes.id}>`
            : (configAtual.cargoLeilaoId ? `\n🧾 Cargo responsável por leilões/resgates mantido: <@&${configAtual.cargoLeilaoId}>` : '\n🧾 Cargo responsável por leilões/resgates: não configurado');
        return interaction.reply({ content: `✅ Configurações salvas!${textoRegistros}${textoLeiloes}${textoCargoLeiloes}${textoForum}`, ephemeral: true });
    }

    // COMANDO /EVENTO
    if (interaction.isChatInputCommand() && interaction.commandName === 'evento') {
        const configGuild = configuracoesPorGuild.get(interaction.guild.id);
        if (!configGuild) return interaction.reply({ content: '❌ Use /configuracoes primeiro.', ephemeral: true });
        if (!membroPodeCriarEvento(interaction, configGuild)) return interaction.reply({ content: '❌ Você não tem o cargo configurado para criar eventos.', ephemeral: true });

        const idEvento = Date.now().toString();
        const nome = interaction.options.getString('nome');
        const lider = interaction.options.getUser('lider');
        const tierEquipamento = campoEventoInformado(interaction.options.getString('tier_equipamento'));
        const ipBuild = normalizarIpBuild(interaction.options.getString('ip_build'));
        if (!tierEquipamento && !ipBuild) {
            return interaction.reply({
                content: '❌ Preencha **tier_equipamento** ou **ip_build** (pelo menos um). Para ignorar um campo, use `null` — ex: tier `4.1-4.2` e ip `null`, ou tier `null` e ip `1450`.',
                ephemeral: true
            });
        }
        const tituloBuildForum = normalizarTituloBuildForum(interaction.options.getString('titulo_build'));
        if (!tituloBuildForum) {
            return interaction.reply({
                content: '❌ Informe **titulo_build** com o nome exato do tópico no fórum (ex: `Baú Dourado - 01`).',
                ephemeral: true
            });
        }
        const horariosRaw = interaction.options.getString('horarios').split(',').map(h => h.trim()).filter(h => h !== '');
        const horariosInvalidos = horariosRaw.filter(h => !horarioValido(h));
        if (horariosInvalidos.length > 0) return interaction.reply({ content: `❌ Horário inválido: ${horariosInvalidos.join(', ')}. Use o formato HH:MM, por exemplo 13:00.`, ephemeral: true });

        const composicao = {
            'TANK': parseWeapons(interaction.options.getString('armas_tank')), 'HEALER': parseWeapons(interaction.options.getString('armas_healer')),
            'SUPORTE': parseWeapons(interaction.options.getString('armas_suporte')), 'DPS': parseWeapons(interaction.options.getString('armas_dps')),
            'DPS RANGER': parseWeapons(interaction.options.getString('armas_ranger'))
        };

        const totalVagas = Object.values(composicao).reduce((acc, arr) => acc + arr.length, 0);
        if (totalVagas === 0 || horariosRaw.length === 0) return interaction.reply({ content: '❌ Faltam parâmetros.', ephemeral: true });

        await interaction.deferReply();
        const numGrupos = Math.min(horariosRaw.length, 10); const grupos = []; const iniciosPrevistosGrupos = [];

        for (let i = 0; i < numGrupos; i++) {
            const minParaInicio = minutosAteHorario(horariosRaw[i]); const inicioMs = minParaInicio !== null ? Date.now() + (minParaInicio * 60 * 1000) : null;
            if (inicioMs) iniciosPrevistosGrupos.push(inicioMs);
            grupos.push({
                horario: horariosRaw[i], participantes: [], notificado: false, canalVozId: null, canalTextoId: null, dashboardMsgId: null,
                inicioPrevistoMs: inicioMs, inicioAtivoMs: null, lootTotal: 0, sacolaTotal: 0, splitSacolas: null, bau: criarEstadoBauPadrao(), fechado: false, fechadoEmMs: null,
                conteudoEstado: 'aguardando', conteudoTempoAcumuladoMs: 0, conteudoRodandoDesdeMs: null, conteudoInicioMs: null
            });
        }

        const novoEvento = {
            id: idEvento, nome, tierEquipamento, ipBuild, tituloBuildForum, lider: lider.id, criadoPorId: interaction.user.id, guildId: interaction.guild.id, categoriaId: configGuild.categoriaId,
            composicao, totalVagas, grupos, criadoEmMs: Date.now(), inicioPrevistoMs: iniciosPrevistosGrupos.length ? Math.min(...iniciosPrevistosGrupos) : null,
            inicioAtivoMs: null, mensagemPrincipalId: null, canalMensagemId: interaction.channel.id
        };

        eventosAtivos.set(idEvento, novoEvento);
        const mensagemPrincipal = await interaction.editReply(gerarInterface(novoEvento));
        novoEvento.mensagemPrincipalId = mensagemPrincipal.id;
        salvarDados();
    }

    // ESCOLHA DE GRUPO/ROLE/ARMA
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_group_')) {
        const idEvento = extrairIdEvento(interaction.customId, 'select_group_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        await interaction.reply({ content: `Você escolheu o **Grupo ${parseInt(interaction.values[0]) + 1}**. Classe:`, components: [gerarMenuRoles(idEvento, interaction.values[0])], ephemeral: true });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_role_')) {
        const partes = interaction.customId.split('_');
        const idEvento = partes[2];
        const indexGrupo = partes[3];
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!evento || !grupo || grupo.fechado) return interaction.update({ content: '❌ Este grupo não está disponível.', components: [] });
        if (interaction.values[0] === 'FULL') return interaction.update({ content: '❌ Lotado.', components: [] });
        if (interaction.values[0] === 'UNAVAILABLE') return interaction.update({ content: '❌ Evento indisponível.', components: [] });
        if (grupo.participantes.some(p => p.id === interaction.user.id)) return interaction.update({ content: '❌ Você já está inscrito neste grupo. Saia do grupo antes de trocar função ou arma.', components: [] });
        const role = slugParaRole(interaction.values[0]);
        await interaction.update({ content: `Classe **${role}**. Arma:`, components: [gerarMenuArmas(idEvento, indexGrupo, role)] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_weapon_')) {
        const resto = interaction.customId.slice('select_weapon_'.length);
        const partes = resto.split('_');
        const idEvento = partes[0];
        const indexGrupo = parseInt(partes[1], 10);
        const role = slugParaRole(partes.slice(2).join('_'));
        const arma = interaction.values[0];
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.update({ content: '❌ Inativo.', components: [] });
        const grupo = evento.grupos[indexGrupo];
        if (!grupo || grupo.fechado) return interaction.update({ content: '❌ Este grupo não está disponível.', components: [] });
        if (arma === 'UNAVAILABLE') return interaction.update({ content: '❌ Nenhuma arma disponível para esta função.', components: [] });
        if (grupo.participantes.some(p => p.id === interaction.user.id)) return interaction.update({ content: '❌ Você já está inscrito neste grupo.', components: [] });
        const armasDisponiveis = getAvailableWeapons(evento.composicao[role] || [], grupo.participantes.filter(p => p.role === role));
        if (!armasDisponiveis.includes(arma)) return interaction.update({ content: '❌ Essa vaga acabou de ser preenchida. Abra o menu novamente para ver as opções atuais.', components: [] });

        const novoParticipante = { id: interaction.user.id, role, arma, totalMs: 0, isPaused: false, lastStartMs: null };
        grupo.participantes.push(novoParticipante);

        if (grupo.canalVozId) await interaction.guild.channels.cache.get(grupo.canalVozId)?.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, Connect: true });
        if (grupo.canalTextoId) {
            await interaction.guild.channels.cache.get(grupo.canalTextoId)?.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        }
        sincronizarParticipanteSeElegivel(interaction.guild, grupo, novoParticipante);
        if (grupo.canalTextoId) await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
        await atualizarMensagemPrincipalEvento(interaction.guild, evento);
        salvarDados();
        const configGuildInscricao = configuracoesPorGuild.get(interaction.guild.id);
        const dmBuildEnviada = await enviarDmInstrucaoBuildParticipante(interaction.user.id, evento, configGuildInscricao, {
            grupo: indexGrupo + 1,
            horario: grupo.horario,
            role,
            arma
        });
        const avisoDm = dmBuildEnviada ? '' : '\n⚠️ Não foi possível enviar a DM com o título da build (verifique se suas DMs estão abertas).';
        await interaction.update({ content: `✅ Registrado!${avisoDm}`, components: [] });
    }

    // BOTÃO: INICIAR / PAUSAR / RETOMAR CONTEÚDO (LÍDER)
    if (interaction.isButton() && interaction.customId.startsWith('dash_conteudo_timer_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) {
            return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode controlar o timer do conteúdo.', ephemeral: true });
        }
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo já foi fechado.', ephemeral: true });

        const estadoAnterior = grupo.conteudoEstado || 'aguardando';
        const novoEstado = alternarConteudoGrupo(interaction.guild, grupo);
        salvarDados();
        await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);

        let mensagem = '✅ Estado do conteúdo atualizado.';
        if (novoEstado === 'rodando' && estadoAnterior === 'aguardando') {
            mensagem = '▶️ **Conteúdo iniciado!** O tempo só conta para quem está na sala de voz.';
        } else if (novoEstado === 'rodando') {
            mensagem = '▶️ **Conteúdo retomado!** Cronômetros ativos na sala de voz.';
        } else {
            mensagem = '⏸️ **Conteúdo pausado.** Todos os cronômetros foram parados.';
        }

        const painel = gerarPainelLiderGrupo(evento, indexGrupo);
        return interaction.reply({ content: mensagem, components: painel.components, ephemeral: true });
    }

    // BOTÃO: ABRIR PAINEL PRIVADO DO LÍDER
    if (interaction.isButton() && interaction.customId.startsWith('dash_leader_panel_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode abrir este painel.', ephemeral: true });
        return interaction.reply(gerarPainelLiderGrupo(evento, indexGrupo));
    }

    // BOTÃO: PAUSAR MEU TEMPO
    if (interaction.isButton() && interaction.customId.startsWith('dash_pause_self_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo não está disponível.', ephemeral: true });
        const participante = grupo.participantes.find(p => p.id === interaction.user.id);
        if (!participante) return interaction.reply({ content: '❌ Não está ativo.', ephemeral: true });
        togglePause(participante);
        sincronizarParticipanteSeElegivel(interaction.guild, grupo, participante);
        let complemento = '';
        if (!participante.isPaused && grupo.conteudoEstado !== 'rodando') complemento = '\nO tempo só contará quando o líder iniciar o conteúdo (Play).';
        else if (!participante.isPaused && !participante.lastStartMs) complemento = '\nEntre na sala de voz para o tempo voltar a contar.';
        await interaction.reply({ content: `✅ Seu cronômetro foi **${participante.isPaused ? 'Pausado' : 'Retomado'}**.${complemento}`, ephemeral: true });
        await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
        salvarDados();
    }

    // MENU: FORÇAR PAUSE (Líder)
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('dash_force_pause_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (interaction.user.id !== evento.lider && interaction.user.id !== evento.criadoPorId) return interaction.reply({ content: '❌ Negado.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        const targetId = interaction.values[0];
        if (!grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo não está disponível.', ephemeral: true });
        const participante = grupo.participantes.find(p => p.id === targetId);
        if (participante) {
            togglePause(participante);
            sincronizarParticipanteSeElegivel(interaction.guild, grupo, participante);
            await interaction.reply({ content: `✅ Cronômetro de <@${targetId}> foi **${participante.isPaused ? 'Pausado' : 'Retomado'}**.`, ephemeral: true });
            await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
            salvarDados();
        } else {
            await interaction.reply({ content: '❌ Participante não encontrado neste grupo.', ephemeral: true });
        }
    }

    // BOTÃO: ADICIONAR SACOLAS (MODAL)
    if (interaction.isButton() && interaction.customId.startsWith('dash_add_loot_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (interaction.user.id !== evento.lider && interaction.user.id !== evento.criadoPorId) return interaction.reply({ content: '❌ Apenas o Líder.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo já foi fechado ou não está disponível.', ephemeral: true });
        const modal = new ModalBuilder().setCustomId(`modal_sacolas_${idEvento}_${indexGrupo}`).setTitle('Lançamento de Sacolas');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val_sacola').setLabel('Valor de Sacolas/Prata Bruta').setPlaceholder('Ex: 1.000.000').setStyle(TextInputStyle.Short).setRequired(true))
        );
        await interaction.showModal(modal);
    }

    // RECEBIMENTO DO MODAL DE SACOLAS
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_sacolas_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!evento || !grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo já foi fechado ou não está disponível.', ephemeral: true });
        const addSacola = parseValorPrata(interaction.fields.getTextInputValue('val_sacola'));
        definirSacolaTotal(grupo, obterSacolaTotal(grupo) + addSacola);
        await interaction.reply({ content: `💰 **${formatarPrata(addSacola)}** adicionadas às sacolas. Total atual: **${formatarPrata(obterSacolaTotal(grupo))}**.`, ephemeral: true });
        await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
        salvarDados();
    }

    // BOTÃO: CALCULAR SPLIT DE SACOLAS, DM E XP
    if (interaction.isButton() && interaction.customId.startsWith('dash_calc_split_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (interaction.user.id !== evento.lider && interaction.user.id !== evento.criadoPorId) return interaction.reply({ content: '❌ Apenas o Líder.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo) return interaction.reply({ content: '❌ Grupo não encontrado.', ephemeral: true });
        if (grupo.fechado) return interaction.reply({ content: '❌ Este split já foi fechado.', ephemeral: true });

        finalizarConteudoGrupo(grupo);
        grupo.participantes.forEach(p => {
            pararCronometroParticipante(p);
            p.isPaused = true;
        });
        const totalMsGeral = grupo.participantes.reduce((acc, p) => acc + p.totalMs, 0);
        if (totalMsGeral === 0) {
            return interaction.reply({
                content: '❌ Tempo zerado. O líder deve **Iniciar Conteúdo (Play)** no painel e os participantes precisam estar na sala de voz durante o conteúdo.',
                ephemeral: true
            });
        }

        const duracaoTotalTexto = formatarDuracaoMs(tempoConteudoAtual(grupo));
        await interaction.reply({ content: '⏳ Processando o split de sacolas, adicionando XP e enviando os recibos na DM...', ephemeral: true });
        const falhasDmParticipantes = [];
        const totalSacolas = obterSacolaTotal(grupo);

        const resultadosSplit = await Promise.all(grupo.participantes.map(async (p) => {
            const fraction = p.totalMs / totalMsGeral;
            const ganho = Math.floor(totalSacolas * fraction);

            // CÁLCULO DE XP (50 XP por hora)
            const horasJogadas = p.totalMs / (1000 * 60 * 60);
            const xpGanho = horasJogadas * 50;

            const chaveBanco = obterChaveXp(interaction.guild.id, p.id);
            const xpAntigo = xpMembros.get(chaveBanco) || 0;
            xpMembros.set(chaveBanco, xpAntigo + xpGanho);

            const dmEmbed = new EmbedBuilder()
                .setTitle(`💰 Recibo de Raid & XP: ${evento.nome}`)
                .setColor('#f1c40f')
                .setDescription(`O split de **Sacolas/Prata Bruta** do **Grupo ${parseInt(indexGrupo) + 1}** foi realizado. O baú será tratado separadamente pelo líder.`)
                .addFields(
                    { name: '⚙️ Tier', value: `\`${valorCampoExibicao(evento.tierEquipamento)}\``, inline: true },
                    { name: '📊 IP', value: `\`${valorCampoExibicao(evento.ipBuild)}\``, inline: true },
                    { name: '⏱️ Tempo da Raid', value: duracaoTotalTexto, inline: true },
                    { name: '⌛ Seu Tempo Ativo', value: formatarDuracaoMs(p.totalMs), inline: true },
                    { name: '⚡ XP Adquirido', value: `**+${Math.floor(xpGanho)} XP**`, inline: true },
                    { name: '💎 Sacolas a Receber', value: `**${formatarPrata(ganho)}**`, inline: false }
                )
                .setFooter({ text: 'Use o comando /ranking no servidor para ver o Placar do Mês!' });

            const dmEnviada = await enviarDmUsuario(p.id, { embeds: [dmEmbed] });
            if (!dmEnviada) falhasDmParticipantes.push(p.id);

            return {
                userId: p.id,
                tempoMs: p.totalMs,
                valor: ganho,
                xpGanho,
                pago: false,
                pagoEmMs: null,
                pagoPorId: null
            };
        }));

        grupo.fechado = true;
        grupo.fechadoEmMs = Date.now();
        grupo.splitSacolas = {
            totalSacolas,
            totalMs: totalMsGeral,
            calculadoEmMs: Date.now(),
            calculadoPorId: interaction.user.id,
            falhasDmParticipantes,
            resultados: resultadosSplit
        };
        resultadosSplit.forEach(resultado => registrarSplitSacolaNoSaldo(evento, indexGrupo, resultado));
        grupo.bau = normalizarBauPersistido(grupo.bau);
        salvarDados();

        const embedSplit = gerarEmbedRegistroEvento(evento, indexGrupo);

        const dmLiderEnviada = await enviarDmUsuario(evento.lider, { embeds: [embedSplit] });
        const configGuild = configuracoesPorGuild.get(interaction.guild.id);
        const registroSplit = await criarCanalRegistroSplit(interaction.guild, evento, indexGrupo, embedSplit, configGuild).catch(error => {
            console.error('Erro ao criar canal de registro do split:', error);
            return { criado: false, motivo: 'erro_ao_criar' };
        });

        if (registroSplit.criado) {
            grupo.splitSacolas.registroChannelId = registroSplit.canalId;
            grupo.splitSacolas.registroMessageId = registroSplit.messageId;
        }

        const msgRelatorio = await interaction.channel.send({
            embeds: [gerarEmbedRegistroEvento(evento, indexGrupo)],
            components: gerarComponentesAberturaPainelPosSplit(evento, indexGrupo)
        });
        grupo.splitSacolas.relatorioChannelId = interaction.channel.id;
        grupo.splitSacolas.relatorioMessageId = msgRelatorio.id;
        salvarDados();

        await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
        await interaction.followUp({
            content: `✅ Split de sacolas concluído. DM do líder: **${dmLiderEnviada ? 'enviada' : 'não entregue'}**. DMs dos participantes com falha: **${falhasDmParticipantes.length}**. Registro: **${registroSplit.criado ? `criado em <#${registroSplit.canalId}>` : 'não criado'}**.\n📦 Agora use **Gerenciar Baú** no relatório para informar print, valor bruto e reparo.`,
            ephemeral: true
        });
    }

    // PAINEL PÓS-FECHAMENTO: PAGAMENTOS DE SACOLAS
    if (interaction.isButton() && interaction.customId.startsWith('dash_payment_panel_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode abrir este painel.', ephemeral: true });
        return interaction.reply(gerarPainelPagamentosGrupo(evento, indexGrupo));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_pay_sacola_')) {
        const [, , , idEvento, indexGrupo, userId] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode confirmar pagamentos.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        const resultado = grupo?.splitSacolas?.resultados?.find(item => item.userId === userId);
        if (!resultado) return interaction.reply({ content: '❌ Participante não encontrado no checklist.', ephemeral: true });
        resultado.pago = true;
        resultado.pagoEmMs = Date.now();
        resultado.pagoPorId = interaction.user.id;
        marcarSacolaPagaNoSaldo(evento, indexGrupo, userId, interaction.user.id);
        salvarDados();
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.update(gerarPainelPagamentosGrupo(evento, indexGrupo));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_pay_all_sacola_')) {
        const [, , , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode confirmar pagamentos.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo?.splitSacolas) return interaction.reply({ content: '❌ Checklist de sacolas não encontrado.', ephemeral: true });
        grupo.splitSacolas.resultados.forEach(resultado => {
            if (!resultado.pago) {
                resultado.pago = true;
                resultado.pagoEmMs = Date.now();
                resultado.pagoPorId = interaction.user.id;
                marcarSacolaPagaNoSaldo(evento, indexGrupo, resultado.userId, interaction.user.id);
            }
        });
        salvarDados();
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.update(gerarPainelPagamentosGrupo(evento, indexGrupo));
    }

    // PAINEL PÓS-FECHAMENTO: BAÚ
    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_panel_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        return interaction.reply(gerarPainelBauGrupo(evento, indexGrupo));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_informar_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        return interaction.showModal(criarModalBau(idEvento, indexGrupo));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_ultimo_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        const printUrl = await buscarUltimoPrintBau(interaction.channel, interaction.user.id);
        if (!printUrl) return interaction.reply({ content: '❌ Não encontrei imagem recente enviada por você neste canal. Envie o print do baú e tente novamente.', ephemeral: true });
        return interaction.showModal(criarModalBau(idEvento, indexGrupo, printUrl));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_sem_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        grupo.bau = { ...criarEstadoBauPadrao(), status: 'sem_bau', decisao: 'sem_bau' };
        salvarDados();
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.update(gerarPainelBauGrupo(evento, indexGrupo));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_bau_') && !interaction.customId.startsWith('modal_bau_buyout_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo?.splitSacolas) return interaction.reply({ content: '❌ Feche primeiro o split de sacolas.', ephemeral: true });
        const valorBruto = parseValorPrata(interaction.fields.getTextInputValue('bau_valor_bruto'));
        const valorReparo = parseValorPrata(interaction.fields.getTextInputValue('bau_valor_reparo'));
        const printUrl = String(interaction.fields.getTextInputValue('bau_print_url') || '').trim() || null;
        const localLoot = limitarTexto(String(interaction.fields.getTextInputValue('bau_local') || '').trim(), 80);
        const descontoPercentual = parsePercentualDesconto(interaction.fields.getTextInputValue('bau_desconto'), 20);
        grupo.bau = {
            ...criarEstadoBauPadrao(),
            status: 'aguardando_decisao',
            printUrl,
            localLoot,
            descontoPercentual,
            valorBruto,
            valorReparo,
            valorLiquido: Math.max(0, valorBruto - valorReparo),
            informadoEmMs: Date.now(),
            informadoPorId: interaction.user.id
        };
        salvarDados();
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.reply(gerarPainelBauGrupo(evento, indexGrupo));
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_buyout_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (grupo?.bau?.status !== 'aguardando_decisao') return interaction.reply({ content: '❌ Informe os dados do baú antes de registrar compra interna.', ephemeral: true });
        return interaction.showModal(criarModalBuyoutBau(evento, indexGrupo));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_bau_buyout_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode gerenciar o baú.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (grupo?.bau?.status !== 'aguardando_decisao') return interaction.reply({ content: '❌ Este baú não está aguardando decisão.', ephemeral: true });
        const compradorId = extrairUserIdTexto(interaction.fields.getTextInputValue('bau_comprador'));
        if (!compradorId || !grupo.participantes.some(p => p.id === compradorId)) {
            return interaction.reply({ content: '❌ Informe a menção ou ID de um membro da própria PT.', ephemeral: true });
        }
        const valorPago = parseValorPrata(interaction.fields.getTextInputValue('bau_valor_pago'));
        if (valorPago <= 0) return interaction.reply({ content: '❌ Informe um valor pago maior que zero.', ephemeral: true });

        const splitFinal = calcularSplitValorPorTempo(grupo, valorPago);
        grupo.bau.status = 'comprado_interno';
        grupo.bau.decisao = 'buyout';
        grupo.bau.compradorId = compradorId;
        grupo.bau.valorPago = valorPago;
        grupo.bau.splitFinal = splitFinal;
        grupo.bau.encerradoEmMs = Date.now();
        grupo.bau.encerradoPorId = interaction.user.id;
        splitFinal.resultados.forEach(resultado => registrarSplitBauNoSaldo(evento, indexGrupo, resultado, 'Baú compra interna'));
        salvarDados();

        for (const resultado of splitFinal.resultados) {
            const dmEmbed = new EmbedBuilder()
                .setTitle(`📦 Split do Baú: ${evento.nome}`)
                .setColor('#2ecc71')
                .setDescription(`O baú do **Grupo ${parseInt(indexGrupo) + 1}** foi comprado internamente por <@${compradorId}>.`)
                .addFields(
                    { name: 'Valor pago', value: formatarPrata(valorPago), inline: true },
                    { name: 'Sua parte', value: `**${formatarPrata(resultado.valor)}**`, inline: true }
                );
            await enviarDmUsuario(resultado.userId, { embeds: [dmEmbed] });
        }

        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        await interaction.channel.send({ embeds: [gerarEmbedRegistroEvento(evento, indexGrupo)] }).catch(() => null);
        return interaction.reply({ content: `✅ Compra interna registrada. O baú foi splitado em **${formatarPrata(valorPago)}**.`, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('dash_bau_leilao_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (!usuarioPodeGerenciarEvento(interaction, evento)) return interaction.reply({ content: '❌ Apenas o líder ou criador do evento pode enviar o baú para leilão.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        const bau = grupo?.bau;
        if (bau?.status !== 'aguardando_decisao') return interaction.reply({ content: '❌ Informe os dados do baú antes de iniciar o leilão.', ephemeral: true });
        if (!bau.printUrl || !urlImagemValida(bau.printUrl)) return interaction.reply({ content: '❌ Informe um print válido do baú antes de criar o leilão.', ephemeral: true });
        if (bau.valorLiquido <= 0) return interaction.reply({ content: '❌ O valor líquido precisa ser maior que zero para iniciar leilão.', ephemeral: true });

        const configGuild = configuracoesPorGuild.get(interaction.guild.id);
        if (!configGuild?.categoriaLeiloesId) return interaction.reply({ content: '❌ Configure a **categoria_leiloes** em /configuracoes antes de enviar baús para leilão.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });

        const categoria = interaction.guild.channels.cache.get(configGuild.categoriaLeiloesId) || await interaction.guild.channels.fetch(configGuild.categoriaLeiloesId).catch(() => null);
        if (!categoria || categoria.type !== ChannelType.GuildCategory) return interaction.editReply({ content: '❌ Categoria de leilões inválida ou inacessível.' });

        const idx = normalizarIndexGrupo(indexGrupo);
        const slugEvento = criarSlug(evento.nome);
        const permissionOverwrites = [];
        if (configGuild.cargoLeilaoId) {
            permissionOverwrites.push({
                id: configGuild.cargoLeilaoId,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
            });
        }
        const prazoEncerramentoMs = adicionarDiasUteis(Date.now(), DIAS_UTEIS_LEILAO);
        const opcoesCanalLeilao = {
            name: `leilao-g${idx + 1}-${slugEvento}`.slice(0, 95),
            type: ChannelType.GuildText,
            parent: categoria.id,
            topic: `Leilão temporário do baú do evento ${evento.nome} | Grupo ${idx + 1}. Prazo: ${formatarDataHora(prazoEncerramentoMs)}.`
        };
        if (permissionOverwrites.length > 0) opcoesCanalLeilao.permissionOverwrites = permissionOverwrites;
        const canalLeilao = await interaction.guild.channels.create(opcoesCanalLeilao);

        bau.status = STATUS_LEILAO_ABERTO;
        bau.decisao = 'leilao';
        bau.leilao = {
            channelId: canalLeilao.id,
            messageId: null,
            lanceInicial: calcularLanceInicial(bau.valorLiquido, bau.descontoPercentual),
            maiorLance: 0,
            maiorLicitanteId: null,
            criadoEmMs: Date.now(),
            criadoPorId: interaction.user.id,
            prazoEncerramentoMs,
            revisaoEmMs: null,
            revisaoNotificadaEmMs: null,
            reabertoEmMs: null,
            reabertoPorId: null
        };

        const msgLeilao = await canalLeilao.send({
            content: `🏷️ **Leilão aberto para o baú do evento ${evento.nome} — Grupo ${idx + 1}.**\nPrazo: **${formatarDataHora(prazoEncerramentoMs)}** (${DIAS_UTEIS_LEILAO} dias úteis).${configGuild.cargoLeilaoId ? `\nResponsáveis: <@&${configGuild.cargoLeilaoId}>` : ''}`,
            embeds: [gerarEmbedLeilao(evento, indexGrupo)],
            components: gerarComponentesLeilao(evento, indexGrupo),
            allowedMentions: configGuild.cargoLeilaoId ? { roles: [configGuild.cargoLeilaoId] } : undefined
        });
        bau.leilao.messageId = msgLeilao.id;
        salvarDados();
        await estenderRetencaoRegistroLeilao(interaction.guild, grupo);
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.editReply({ content: `✅ Leilão criado em <#${canalLeilao.id}> com lance inicial de **${formatarPrata(bau.leilao.lanceInicial)}**. Prazo: **${formatarDataHora(prazoEncerramentoMs)}**.` });
    }

    if (interaction.isButton() && interaction.customId.startsWith('auction_bid_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        const leilao = grupo?.bau?.leilao;
        if (!evento || grupo?.bau?.status !== STATUS_LEILAO_ABERTO || !leilao) return interaction.reply({ content: '❌ Este leilão não está ativo.', ephemeral: true });
        if (await enviarLeilaoParaRevisao(interaction.guild, evento, indexGrupo)) {
            return interaction.reply({ content: '⏳ O prazo deste leilão acabou. Ele foi enviado para revisão dos responsáveis.', ephemeral: true });
        }
        const modal = new ModalBuilder().setCustomId(`modal_auction_bid_${idEvento}_${indexGrupo}`).setTitle('Dar Lance');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('valor_lance').setLabel('Valor do lance').setPlaceholder('Ex: 4.800.000').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_auction_bid_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        const leilao = grupo?.bau?.leilao;
        if (!evento || grupo?.bau?.status !== STATUS_LEILAO_ABERTO || !leilao) return interaction.reply({ content: '❌ Este leilão não está ativo.', ephemeral: true });
        if (await enviarLeilaoParaRevisao(interaction.guild, evento, indexGrupo)) {
            return interaction.reply({ content: '⏳ O prazo deste leilão acabou antes do seu lance. Ele foi enviado para revisão dos responsáveis.', ephemeral: true });
        }
        const valorLance = parseValorPrata(interaction.fields.getTextInputValue('valor_lance'));
        if (valorLance < leilao.lanceInicial) return interaction.reply({ content: `❌ O lance mínimo é **${formatarPrata(leilao.lanceInicial)}**.`, ephemeral: true });
        if (leilao.maiorLance && valorLance <= leilao.maiorLance) return interaction.reply({ content: `❌ O lance precisa superar o atual: **${formatarPrata(leilao.maiorLance)}**.`, ephemeral: true });

        const licitanteAnteriorId = leilao.maiorLicitanteId;
        const lanceAnterior = leilao.maiorLance;
        leilao.maiorLance = valorLance;
        leilao.maiorLicitanteId = interaction.user.id;
        leilao.atualizadoEmMs = Date.now();
        leilao.historicoLances = Array.isArray(leilao.historicoLances) ? leilao.historicoLances : [];
        leilao.historicoLances.push({ userId: interaction.user.id, valor: valorLance, criadoEmMs: Date.now() });
        leilao.historicoLances = leilao.historicoLances.slice(-30);
        salvarDados();

        await atualizarMensagemLeilao(interaction.guild, evento, indexGrupo);
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        if (licitanteAnteriorId && licitanteAnteriorId !== interaction.user.id) {
            const avisoEmbed = new EmbedBuilder()
                .setTitle('⚠️ Seu lance foi superado')
                .setColor('#f39c12')
                .setDescription(`Seu lance no leilão **${evento.nome} — Grupo ${normalizarIndexGrupo(indexGrupo) + 1}** foi ultrapassado.`)
                .addFields(
                    { name: 'Seu lance anterior', value: formatarPrata(lanceAnterior), inline: true },
                    { name: 'Novo maior lance', value: `${formatarPrata(valorLance)} por <@${interaction.user.id}>`, inline: true },
                    { name: 'Canal do leilão', value: leilao.channelId ? `<#${leilao.channelId}>` : 'Canal não localizado', inline: false }
                )
                .setFooter({ text: 'Você pode voltar ao canal do leilão e cobrir a oferta enquanto ele estiver aberto.' });
            await enviarDmUsuario(licitanteAnteriorId, { embeds: [avisoEmbed] });
        }
        return interaction.reply({ content: `✅ Lance registrado: **${formatarPrata(valorLance)}**.`, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('auction_review_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!evento || grupo?.bau?.status !== STATUS_LEILAO_REVISAO || !grupo.bau.leilao) return interaction.reply({ content: '❌ Este leilão não está em revisão.', ephemeral: true });
        if (!await usuarioPodeOperarLeilao(interaction, evento.guildId)) return interaction.reply({ content: '❌ Apenas o cargo responsável por leilões pode revisar este leilão.', ephemeral: true });
        return interaction.showModal(criarModalRevisaoLeilao(evento, indexGrupo));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_auction_review_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        const bau = grupo?.bau;
        const leilao = bau?.leilao;
        if (!evento || bau?.status !== STATUS_LEILAO_REVISAO || !leilao) return interaction.reply({ content: '❌ Este leilão não está em revisão.', ephemeral: true });
        if (!await usuarioPodeOperarLeilao(interaction, evento.guildId)) return interaction.reply({ content: '❌ Apenas o cargo responsável por leilões pode revisar este leilão.', ephemeral: true });

        const valorBruto = parseValorPrata(interaction.fields.getTextInputValue('bau_valor_bruto'));
        const valorReparo = parseValorPrata(interaction.fields.getTextInputValue('bau_valor_reparo'));
        const descontoPercentual = parsePercentualDesconto(interaction.fields.getTextInputValue('bau_desconto'), bau.descontoPercentual ?? 20);
        const valorLiquido = Math.max(0, valorBruto - valorReparo);
        if (valorBruto <= 0) return interaction.reply({ content: '❌ Informe um valor bruto maior que zero.', ephemeral: true });
        if (valorLiquido <= 0) return interaction.reply({ content: '❌ O valor líquido revisado precisa ser maior que zero.', ephemeral: true });

        bau.valorBruto = valorBruto;
        bau.valorReparo = valorReparo;
        bau.valorLiquido = valorLiquido;
        bau.descontoPercentual = descontoPercentual;
        leilao.lanceInicial = calcularLanceInicial(valorLiquido, descontoPercentual);
        leilao.revisadoEmMs = Date.now();
        leilao.revisadoPorId = interaction.user.id;

        let avisoLance = '';
        if (leilao.maiorLance && leilao.maiorLance < leilao.lanceInicial) {
            const licitanteAnteriorId = leilao.maiorLicitanteId;
            const lanceAnterior = leilao.maiorLance;
            leilao.maiorLance = 0;
            leilao.maiorLicitanteId = null;
            leilao.atualizadoEmMs = Date.now();
            avisoLance = '\nO maior lance anterior ficou abaixo do novo lance inicial e foi removido.';
            if (licitanteAnteriorId) {
                const avisoEmbed = new EmbedBuilder()
                    .setTitle('⚠️ Lance removido após revisão')
                    .setColor('#f39c12')
                    .setDescription(`Seu lance no leilão **${evento.nome} — Grupo ${normalizarIndexGrupo(indexGrupo) + 1}** ficou abaixo do novo lance inicial após a revisão dos responsáveis.`)
                    .addFields(
                        { name: 'Seu lance', value: formatarPrata(lanceAnterior), inline: true },
                        { name: 'Novo lance inicial', value: formatarPrata(leilao.lanceInicial), inline: true },
                        { name: 'Canal do leilão', value: leilao.channelId ? `<#${leilao.channelId}>` : 'Canal não localizado', inline: false }
                    );
                await enviarDmUsuario(licitanteAnteriorId, { embeds: [avisoEmbed] });
            }
        }

        salvarDados();
        await atualizarMensagemLeilao(interaction.guild, evento, indexGrupo);
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.reply({ content: `✅ Valores revisados. Novo lance inicial: **${formatarPrata(leilao.lanceInicial)}**.${avisoLance}`, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('auction_reopen_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        const bau = grupo?.bau;
        const leilao = bau?.leilao;
        if (!evento || bau?.status !== STATUS_LEILAO_REVISAO || !leilao) return interaction.reply({ content: '❌ Este leilão não está em revisão.', ephemeral: true });
        if (!await usuarioPodeOperarLeilao(interaction, evento.guildId)) return interaction.reply({ content: '❌ Apenas o cargo responsável por leilões pode reabrir este leilão.', ephemeral: true });
        if (bau.valorLiquido <= 0) return interaction.reply({ content: '❌ Revise os valores do baú antes de reabrir este leilão.', ephemeral: true });

        const novoPrazo = adicionarDiasUteis(Date.now(), DIAS_UTEIS_LEILAO);
        bau.status = STATUS_LEILAO_ABERTO;
        leilao.lanceInicial = calcularLanceInicial(bau.valorLiquido, bau.descontoPercentual);
        leilao.prazoEncerramentoMs = novoPrazo;
        leilao.reabertoEmMs = Date.now();
        leilao.reabertoPorId = interaction.user.id;
        leilao.revisaoNotificadaEmMs = null;
        leilao.atualizadoEmMs = Date.now();
        salvarDados();

        const { canal } = await atualizarMensagemLeilao(interaction.guild, evento, indexGrupo);
        if (canal?.setTopic) {
            await canal.setTopic(`Leilão temporário do baú do evento ${evento.nome} | Grupo ${normalizarIndexGrupo(indexGrupo) + 1}. Prazo: ${formatarDataHora(novoPrazo)}.`).catch(() => null);
        }
        if (canal?.send) {
            await canal.send({
                content: `🔄 Leilão reaberto por <@${interaction.user.id}>. Novo prazo: **${formatarDataHora(novoPrazo)}**.`,
                allowedMentions: { users: [interaction.user.id] }
            }).catch(() => null);
        }
        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        return interaction.reply({ content: `✅ Leilão reaberto até **${formatarDataHora(novoPrazo)}**.`, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('auction_close_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        const ehAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
        const podeOperarLeilao = await usuarioPodeOperarLeilao(interaction, evento.guildId);
        if (!usuarioPodeGerenciarEvento(interaction, evento) && !ehAdmin && !podeOperarLeilao) return interaction.reply({ content: '❌ Apenas o líder, criador do evento, administrador ou cargo responsável por leilões pode encerrar o leilão.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        const leilao = grupo?.bau?.leilao;
        if (grupo?.bau?.status === STATUS_LEILAO_ABERTO && await enviarLeilaoParaRevisao(interaction.guild, evento, indexGrupo)) {
            return interaction.reply({ content: '⏳ O prazo deste leilão acabou. Ele foi enviado para revisão dos responsáveis antes de qualquer encerramento.', ephemeral: true });
        }
        if (grupo?.bau?.status !== STATUS_LEILAO_ABERTO || !leilao) return interaction.reply({ content: '❌ Este leilão não está ativo.', ephemeral: true });
        if (!leilao.maiorLance || !leilao.maiorLicitanteId) return interaction.reply({ content: '❌ Ainda não há lance para encerrar este leilão.', ephemeral: true });

        const splitFinal = calcularSplitValorPorTempo(grupo, leilao.maiorLance);
        grupo.bau.status = STATUS_LEILAO_VENDIDO;
        grupo.bau.decisao = 'leilao';
        grupo.bau.compradorId = leilao.maiorLicitanteId;
        grupo.bau.valorPago = leilao.maiorLance;
        grupo.bau.splitFinal = splitFinal;
        grupo.bau.encerradoEmMs = Date.now();
        grupo.bau.encerradoPorId = interaction.user.id;
        splitFinal.resultados.forEach(resultado => registrarSplitBauNoSaldo(evento, indexGrupo, resultado, 'Baú leiloado'));
        salvarDados();

        await atualizarMensagemLeilao(interaction.guild, evento, indexGrupo);

        for (const resultado of splitFinal.resultados) {
            const dmEmbed = new EmbedBuilder()
                .setTitle(`📦 Split do Baú Leiloado: ${evento.nome}`)
                .setColor('#2ecc71')
                .setDescription(`O leilão do baú do **Grupo ${parseInt(indexGrupo) + 1}** foi encerrado.`)
                .addFields(
                    { name: 'Vencedor', value: `<@${leilao.maiorLicitanteId}>`, inline: true },
                    { name: 'Valor final', value: formatarPrata(leilao.maiorLance), inline: true },
                    { name: 'Sua parte', value: `**${formatarPrata(resultado.valor)}**`, inline: false }
                );
            await enviarDmUsuario(resultado.userId, { embeds: [dmEmbed] });
        }

        await atualizarRegistroEvento(interaction.guild, evento, indexGrupo);
        await interaction.channel.send({ embeds: [gerarEmbedRegistroEvento(evento, indexGrupo)] }).catch(() => null);
        return interaction.reply({ content: `✅ Leilão encerrado por **${formatarPrata(leilao.maiorLance)}**. Registro atualizado.`, ephemeral: true });
    }

    // SALDO: SOLICITAÇÃO E PAGAMENTO DE RESGATE
    if (interaction.isButton() && interaction.customId.startsWith('saldo_resgate_')) {
        const resto = interaction.customId.slice('saldo_resgate_'.length);
        const [guildId, userId] = resto.split('_');
        return solicitarResgateSaldo(interaction, guildId, userId);
    }

    if (interaction.isButton() && interaction.customId.startsWith('saldo_pagar_')) {
        const resto = interaction.customId.slice('saldo_pagar_'.length);
        const [guildId, userId, resgateId] = resto.split('_');
        return marcarResgateComoPago(interaction, guildId, userId, resgateId);
    }

    // BOTÃO: SAIR DO EVENTO
    if (interaction.isButton() && (interaction.customId.startsWith('dash_leave_') || interaction.customId.startsWith('leave_all_'))) {
        const isDash = interaction.customId.startsWith('dash_leave_');
        const idEvento = isDash ? interaction.customId.split('_')[2] : extrairIdEvento(interaction.customId, 'leave_all_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (evento) {
            for (const [index, grupo] of evento.grupos.entries()) {
                grupo.participantes = grupo.participantes.filter(p => p.id !== interaction.user.id);
                if (grupo.canalVozId) await interaction.guild.channels.cache.get(grupo.canalVozId)?.permissionOverwrites.delete(interaction.user.id).catch(()=>null);
                if (grupo.canalTextoId) await interaction.guild.channels.cache.get(grupo.canalTextoId)?.permissionOverwrites.delete(interaction.user.id).catch(()=>null);
                if (isDash && parseInt(interaction.customId.split('_')[3]) === index) await atualizarMsgDashboard(interaction.guild, evento, index);
            }
            await atualizarMensagemPrincipalEvento(interaction.guild, evento);
            salvarDados();
            if (isDash) await interaction.reply({ content: '✅ Removido.', ephemeral: true });
            else await interaction.update(gerarInterface(evento));
        }
    }

    // BOTÃO: ENCERRAR EVENTO DEFINITIVO
    if (interaction.isButton() && interaction.customId.startsWith('end_event_')) {
        const idEvento = extrairIdEvento(interaction.customId, 'end_event_');
        let evento = obterEvento(idEvento, interaction);

        if (!evento) {
            if (!usuarioPodeEncerrarMensagemAntiga(interaction, idEvento)) {
                return interaction.reply({
                    content: '❌ Este evento não está mais na memória do bot (reinício ou dados antigos). Apenas o **líder**, quem **criou** o evento ou um **administrador** pode encerrar esta mensagem.',
                    ephemeral: true
                });
            }
            return encerrarMensagemEventoSemMemoria(interaction, idEvento);
        }

        const ehCriador = interaction.user.id === evento.criadoPorId;
        const ehLider = interaction.user.id === evento.lider;
        const ehAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
        if (!ehCriador && !ehLider && !ehAdmin) {
            return interaction.reply({ content: '❌ Apenas o administrador, o líder ou quem criou o evento pode encerrá-lo.', ephemeral: true });
        }

        const manterPorLeilaoAberto = eventoTemLeilaoAberto(evento);
        for (const grupo of evento.grupos) {
            if (grupo.canalVozId) await interaction.guild.channels.cache.get(grupo.canalVozId)?.delete().catch(() => null);
            if (grupo.canalTextoId) await interaction.guild.channels.cache.get(grupo.canalTextoId)?.delete().catch(() => null);
            grupo.canalVozId = null;
            grupo.canalTextoId = null;
            grupo.dashboardMsgId = null;
        }

        if (manterPorLeilaoAberto) {
            evento.encerradoDefinitivo = true;
            evento.encerradoDefinitivoEmMs = Date.now();
            salvarDados();
        } else {
            removerEventoPersistido(idEvento);
        }

        const detalhe = manterPorLeilaoAberto
            ? 'As salas do evento foram apagadas, mas o registro ficou armazenado por causa de leilão em aberto ou em revisão. O split do baú continuará funcionando no canal de leilão.'
            : undefined;
        await interaction.update({ embeds: [gerarEmbedEventoEncerrado(interaction.user.id, detalhe)], components: [] });
    }
    } catch (error) {
        console.error('Erro ao processar interação:', error);
        const respostaErro = { content: '❌ Ocorreu um erro ao processar esta ação. Verifique o console do bot para mais detalhes.', ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.followUp(respostaErro).catch(() => null);
        else await interaction.reply(respostaErro).catch(() => null);
    }
});

client.login(DISCORD_TOKEN);
