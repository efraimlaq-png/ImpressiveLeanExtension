            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val_bau').setLabel('Valor do Baú').setPlaceholder('Ex: 5.500.000').setStyle(TextInputStyle.Short).setRequired(false))
        );
        await interaction.showModal(modal);
    }

    // RECEBIMENTO DO MODAL DE LOOT
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_loot_')) {
        const [, , idEvento, indexGrupo] = interaction.customId.split('_'); const evento = eventosAtivos.get(idEvento); const grupo = evento?.grupos[indexGrupo];
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
        const evento = eventosAtivos.get(idEvento);
        if (!evento) return interaction.reply({ content: '❌ Este evento não está mais ativo.', ephemeral: true });
        if (interaction.user.id !== evento.lider && interaction.user.id !== evento.criadoPorId) return interaction.reply({ content: '❌ Apenas o Líder.', ephemeral: true });
        const grupo = evento.grupos[indexGrupo];
        if (!grupo) return interaction.reply({ content: '❌ Grupo não encontrado.', ephemeral: true });
        if (grupo.fechado) return interaction.reply({ content: '❌ Este split já foi fechado.', ephemeral: true });

        grupo.participantes.forEach(p => {
            pararCronometroParticipante(p);
            p.isPaused = true;
        });
        const totalMsGeral = grupo.participantes.reduce((acc, p) => acc + p.totalMs, 0);
        if (totalMsGeral === 0) return interaction.reply({ content: '❌ Tempo zerado.', ephemeral: true });

        const duracaoTotalTexto = formatarDuracaoMs(grupo.inicioAtivoMs ? Date.now() - grupo.inicioAtivoMs : 0);
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
        embedSplit.setDescription(`💰 **Loot Total Arrecadado:** ${grupo.lootTotal.toLocaleString('pt-BR')} Pratas\n⏱️ **Soma do Tempo Total da PT:** ${formatarDuracaoMs(totalMsGeral)}\n\n*Os pontos de XP foram adicionados à conta de cada membro no banco de dados!*`);
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
        const idEvento = interaction.customId.split('_')[2]; const evento = eventosAtivos.get(idEvento);
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

    // BOTÃO: ENCERRAR EVENTO DEFINITIVO (CORRIGIDO)
    if (interaction.isButton() && interaction.customId.startsWith('end_event_')) {
        const idEvento = interaction.customId.split('_')[2];
        const evento = eventosAtivos.get(idEvento);

        if (!evento) {
            if (!usuarioPodeEncerrarMensagemAntiga(interaction)) return interaction.reply({ content: '❌ Este evento não está mais ativo e o bot não conseguiu confirmar sua permissão para encerrar. Peça para o líder ou um administrador encerrar esta mensagem antiga.', ephemeral: true });
            return encerrarMensagemEventoSemMemoria(interaction);
        }

        const ehCriador = interaction.user.id === evento.criadoPorId;
        const ehLider = interaction.user.id === evento.lider;
        const ehAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
        if (!ehCriador && !ehLider && !ehAdmin) return interaction.reply({ content: '❌ Apenas o Administrador, o líder ou quem criou o evento pode encerrá-lo.', ephemeral: true });

        for (const grupo of evento.grupos) {
            if (grupo.canalVozId) await interaction.guild.channels.cache.get(grupo.canalVozId)?.delete().catch(()=>null);
            if (grupo.canalTextoId) await interaction.guild.channels.cache.get(grupo.canalTextoId)?.delete().catch(()=>null);
        }

        eventosAtivos.delete(idEvento);
        salvarDados();

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