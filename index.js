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

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const eventosAtivos = new Map();
const configuracoesPorGuild = new Map();
const CONFIG_PATH = path.join(__dirname, 'guild-config.json');
const XP_PATH = path.join(__dirname, 'xp-config.json');
const REGISTROS_PATH = path.join(__dirname, 'registros-canais.json');
const EVENTOS_PATH = path.join(__dirname, 'eventos-ativos.json');
const xpMembros = new Map();
const registrosCanais = new Map();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const TIME_ZONE = process.env.TIME_ZONE || 'America/Sao_Paulo';
const MINUTOS_ABERTURA_SALA = 30;
const MAX_OPCOES_MENU = 25;
const DIAS_RETENCAO_REGISTROS = 5;
const TEMPO_RETENCAO_REGISTROS_MS = DIAS_RETENCAO_REGISTROS * 24 * 60 * 60 * 1000;

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
    const lootFormatado = grupo.lootTotal.toLocaleString('pt-BR');

    const embed = new EmbedBuilder()
        .setTitle(`🛡️ GERENCIAMENTO DE GRUPO: BLOCO ${idx + 1}`)
        .setColor(grupo.conteudoEstado === 'rodando' ? '#2ecc71' : '#95a5a6')
        .setDescription(`**Horário Oficial:** ${grupo.horario}\n**Tempo de Conteúdo:** ⏱️ ${obterStatusConteudoGrupo(grupo)}\n**Loot Total Acumulado:** 💰 \`${lootFormatado} Pratas\`\n\n*O tempo só conta após o líder iniciar o conteúdo (Play).*`);

    let listagem = '';
    grupo.participantes.forEach(p => {
        const statusEmoji = emojiStatusParticipante(grupo, p);
        const tempo = formatarDuracaoMs(tempoTotalAtual(p));
        listagem += `${statusEmoji} \`[${tempo}]\` <@${p.id}> — **${p.role}** [${p.arma}]\n`;
    });

    adicionarCampoLongo(embed, '👥 Participantes e Cronômetros', listagem || '*Nenhum participante restando no grupo.*');

    if (grupo.fechado) {
        embed.setColor('#7f8c8d');
        embed.addFields({ name: '✅ Status', value: '*Split fechado. Este dashboard está bloqueado para novas alterações.*', inline: false });
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
    if (!grupo || grupo.fechado) {
        return { content: '❌ Este grupo já foi fechado ou não está disponível.', components: [], ephemeral: true };
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
        new ButtonBuilder().setCustomId(`dash_add_loot_${evento.id}_${idx}`).setLabel('Adicionar Valores (Split)').setEmoji('💰').setStyle(ButtonStyle.Success),
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
        const guild = client.guilds.cache.get(registro.guildId) || await client.guilds.fetch(registro.guildId).catch(() => null);
        const canal = guild ? (guild.channels.cache.get(registro.channelId) || await guild.channels.fetch(registro.channelId).catch(() => null)) : null;
        if (canal) await canal.delete('Registro temporário expirado após 5 dias.').catch(() => null);
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

    await canalRegistro.send({
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
    return { criado: true, canalId: canalRegistro.id };
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
    .addChannelOption(opt => opt.setName('canal_forum_builds').setDescription('Canal fórum das builds (Conteúdo - 01, Baú Dourado - 01...)').addChannelTypes(ChannelType.GuildForum).setRequired(false))
    .addChannelOption(opt => opt.setName('categoria_leiloes').setDescription('Categoria onde os canais de leilão gerados pelo bot serão alocados').addChannelTypes(ChannelType.GuildCategory).setRequired(false));

const comandoRanking = new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('Mostra o Top 10 membros com mais XP de atividade no mês');

const COMANDOS_SLASH_JSON = [
    comandoEvento.toJSON(),
    comandoConfiguracoes.toJSON(),
    comandoRanking.toJSON()
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

    // COMANDO /CONFIGURACOES
    if (interaction.isChatInputCommand() && interaction.commandName === 'configuracoes') {
        const categoria = interaction.options.getChannel('categoria_canais');
        const cargoEvento = interaction.options.getRole('cargo_evento');
        const categoriaRegistros = interaction.options.getChannel('categoria_registros');
        const canalForumBuilds = interaction.options.getChannel('canal_forum_builds');
        const configAtual = configuracoesPorGuild.get(interaction.guild.id) || {};
        configuracoesPorGuild.set(interaction.guild.id, {
            categoriaId: categoria.id,
            cargoEventoId: cargoEvento.id,
            categoriaRegistrosId: categoriaRegistros?.id || configAtual.categoriaRegistrosId || null,
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
        return interaction.reply({ content: `✅ Configurações salvas!${textoRegistros}${textoForum}`, ephemeral: true });
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
                inicioPrevistoMs: inicioMs, inicioAtivoMs: null, lootTotal: 0, fechado: false, fechadoEmMs: null,
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

    // BOTÃO: ADICIONAR LOOT (MODAL)
    if (interaction.isButton() && interaction.customId.startsWith('dash_add_loot_')) {
        const [, , , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (interaction.user.id !== evento.lider && interaction.user.id !== evento.criadoPorId) return interaction.reply({ content: '❌ Apenas o Líder.', ephemeral: true });
        const grupo = evento.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo já foi fechado ou não está disponível.', ephemeral: true });
        const modal = new ModalBuilder().setCustomId(`modal_loot_${idEvento}_${indexGrupo}`).setTitle('Lançamento de Split / Economia');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val_sacola').setLabel('Valor de Sacolas').setPlaceholder('Ex: 1.000.000').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val_bau').setLabel('Valor do Baú').setPlaceholder('Ex: 5.500.000').setStyle(TextInputStyle.Short).setRequired(false))
        );
        await interaction.showModal(modal);
    }

    // RECEBIMENTO DO MODAL DE LOOT
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_loot_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_');
        const evento = obterEvento(idEvento, interaction);
        const grupo = evento?.grupos[normalizarIndexGrupo(indexGrupo)];
        if (!evento || !grupo || grupo.fechado) return interaction.reply({ content: '❌ Este grupo já foi fechado ou não está disponível.', ephemeral: true });
        const getNum = (str) => parseInt((str || '0').replace(/\D/g, '')) || 0;
        const addSacola = getNum(interaction.fields.getTextInputValue('val_sacola')); const addBau = getNum(interaction.fields.getTextInputValue('val_bau'));
        grupo.lootTotal += (addSacola + addBau);
        await interaction.reply({ content: `💰 **${(addSacola + addBau).toLocaleString('pt-BR')} Pratas** adicionadas!`, ephemeral: true });
        await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
        salvarDados();
    }

    // BOTÃO: CALCULAR SPLIT, DM E XP
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
        await interaction.reply({ content: '⏳ Processando o fechamento da PT, adicionando XP e enviando os recibos na DM...', ephemeral: true });
        const falhasDmParticipantes = [];

        const resultadosSplit = await Promise.all(grupo.participantes.map(async (p) => {
            const fraction = p.totalMs / totalMsGeral;
            const ganho = Math.floor(grupo.lootTotal * fraction);

            // CÁLCULO DE XP (50 XP por hora)
            const horasJogadas = p.totalMs / (1000 * 60 * 60);
            const xpGanho = horasJogadas * 50;

            const chaveBanco = obterChaveXp(interaction.guild.id, p.id);
            const xpAntigo = xpMembros.get(chaveBanco) || 0;
            xpMembros.set(chaveBanco, xpAntigo + xpGanho);

            const dmEmbed = new EmbedBuilder()
                .setTitle(`💰 Recibo de Raid & XP: ${evento.nome}`)
                .setColor('#f1c40f')
                .setDescription(`O fechamento do **Grupo ${parseInt(indexGrupo) + 1}** foi realizado! Seus pontos e valores foram computados.`)
                .addFields(
                    { name: '⚙️ Tier', value: `\`${valorCampoExibicao(evento.tierEquipamento)}\``, inline: true },
                    { name: '📊 IP', value: `\`${valorCampoExibicao(evento.ipBuild)}\``, inline: true },
                    { name: '⏱️ Tempo da Raid', value: duracaoTotalTexto, inline: true },
                    { name: '⌛ Seu Tempo Ativo', value: formatarDuracaoMs(p.totalMs), inline: true },
                    { name: '⚡ XP Adquirido', value: `**+${Math.floor(xpGanho)} XP**`, inline: true },
                    { name: '💎 Pratas a Receber', value: `**${ganho.toLocaleString('pt-BR')} Pratas**`, inline: false }
                )
                .setFooter({ text: 'Use o comando /ranking no servidor para ver o Placar do Mês!' });

            const dmEnviada = await enviarDmUsuario(p.id, { embeds: [dmEmbed] });
            if (!dmEnviada) falhasDmParticipantes.push(p.id);

            return `<@${p.id}> [${formatarDuracaoMs(p.totalMs)}] ➜ **${ganho.toLocaleString('pt-BR')} Pratas** *(+${Math.floor(xpGanho)} XP)*`;
        }));

        grupo.fechado = true;
        grupo.fechadoEmMs = Date.now();
        salvarDados();

        const embedSplit = new EmbedBuilder().setTitle(`⚖️ RELATÓRIO FINAL DE EVENTO - GRUPO ${parseInt(indexGrupo) + 1}`).setColor('#f1c40f');
        embedSplit.setDescription(`${textoRequisitosBuild(evento, configuracoesPorGuild.get(interaction.guild.id))}\n💰 **Loot Total Arrecadado:** ${grupo.lootTotal.toLocaleString('pt-BR')} Pratas\n⏱️ **Soma do Tempo Total da PT:** ${formatarDuracaoMs(totalMsGeral)}\n\n*Os pontos de XP foram adicionados à conta de cada membro no banco de dados!*`);
        adicionarCampoLongo(embedSplit, 'Tabela de Distribuição e Pontuação', resultadosSplit.join('\n') || 'Sem jogadores.');
        if (falhasDmParticipantes.length > 0) {
            adicionarCampoLongo(embedSplit, '⚠️ DMs não entregues aos participantes', falhasDmParticipantes.map(id => `<@${id}>`).join(', '));
        }

        const dmLiderEnviada = await enviarDmUsuario(evento.lider, { embeds: [embedSplit] });
        const configGuild = configuracoesPorGuild.get(interaction.guild.id);
        const registroSplit = await criarCanalRegistroSplit(interaction.guild, evento, indexGrupo, embedSplit, configGuild).catch(error => {
            console.error('Erro ao criar canal de registro do split:', error);
            return { criado: false, motivo: 'erro_ao_criar' };
        });

        await interaction.channel.send({ embeds: [embedSplit] });
        await atualizarMsgDashboard(interaction.guild, evento, indexGrupo);
        await interaction.followUp({
            content: `✅ Fechamento concluído. DM do líder: **${dmLiderEnviada ? 'enviada' : 'não entregue'}**. DMs dos participantes com falha: **${falhasDmParticipantes.length}**. Registro: **${registroSplit.criado ? `criado em <#${registroSplit.canalId}>` : 'não criado'}**.`,
            ephemeral: true
        });
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

        for (const grupo of evento.grupos) {
            if (grupo.canalVozId) await interaction.guild.channels.cache.get(grupo.canalVozId)?.delete().catch(() => null);
            if (grupo.canalTextoId) await interaction.guild.channels.cache.get(grupo.canalTextoId)?.delete().catch(() => null);
        }

        removerEventoPersistido(idEvento);

        await interaction.update({ embeds: [gerarEmbedEventoEncerrado(interaction.user.id)], components: [] });
    }
    } catch (error) {
        console.error('Erro ao processar interação:', error);
        const respostaErro = { content: '❌ Ocorreu um erro ao processar esta ação. Verifique o console do bot para mais detalhes.', ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.followUp(respostaErro).catch(() => null);
        else await interaction.reply(respostaErro).catch(() => null);
    }
});

client.login(DISCORD_TOKEN);