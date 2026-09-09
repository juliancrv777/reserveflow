# ReserveFlow — guia de estudo e apresentação

## O que o projeto resolve

Uma oficina tem cinco vagas. Se vinte pessoas tentarem reservar ao mesmo tempo, apenas cinco reservas podem ser confirmadas. Se a internet falhar depois da confirmação, repetir a requisição não deve consumir outra vaga. Se um cancelamento for repetido, a vaga deve voltar apenas uma vez.

O projeto implementa essas regras numa API com autenticação por chave, banco persistente, registro de auditoria e testes automatizados. É um projeto de portfólio; não representa experiência de trabalho em uma empresa nem um produto com usuários reais.

## Primeiros passos

1. Instale Node.js 24.15 ou superior da linha 24.
2. Abra o terminal na pasta do projeto.
3. Execute `npm run demo`: ele cria um banco temporário e demonstra os casos principais.
4. Execute `npm test`: leia os nomes dos cenários e confira que todos passam.
5. Leia `src/service.js` junto com o registro de arquitetura.
6. Siga os comandos do README para iniciar a API persistente e fazer chamadas manualmente.

No PowerShell, se a política de execução bloquear `npm`, use `npm.cmd` nos mesmos comandos. A demonstração não precisa de conta, Docker ou instalação de pacotes.

## Roteiro para uma apresentação de cinco minutos

**Primeiro minuto:** explique o problema das cinco vagas e o que poderia dar errado com requisições simultâneas.

**Segundo minuto:** rode `npm run demo`. Mostre as cinco confirmações e as quinze recusas. Explique que esses números são de um teste funcional local, não uma medição de capacidade do sistema em produção.

**Terceiro minuto:** abra a função `reserve`. Mostre a transação, a atualização condicional e o armazenamento da resposta de idempotência. Explique a diferença entre repetir uma operação e consultar o estado atual.

**Quarto minuto:** mostre o teste que força falha na auditoria e verifica o rollback. Depois mostre o teste com conexões independentes disputando a última vaga.

**Quinto minuto:** discuta as limitações: SQLite tem um escritor por vez, o acesso síncrono bloqueia o processo, faltam gestão de chaves e operação em produção. Explique quais medições justificariam PostgreSQL.

## Perguntas que você precisa saber responder

| Pergunta | Ponto principal |
| --- | --- |
| Por que só consultar o saldo antes de reservar não basta? | Outra conexão pode alterar o saldo entre a leitura e a escrita. |
| O que acontece se a auditoria falhar? | A transação desfaz também a reserva, o estoque e a idempotência. |
| E se a resposta se perder depois do commit? | A mesma chave devolve o resultado gravado. |
| A mesma chave pode ser usada por dois clientes? | Sim, a identidade inclui o cliente. |
| Por que um retry após cancelar mostra `confirmed`? | Ele reproduz a criação original; o GET consulta o estado atual. |
| Por que SHA-256 para essas chaves? | São tokens aleatórios com alta entropia, não senhas humanas. |
| O sistema suporta milhões de usuários? | Isso não foi medido; o desenho atual é deliberadamente de um único host. |
| Qual é a diferença entre os dois testes de concorrência? | HTTP testa o contrato; workers usam conexões independentes e disputam o bloqueio real do banco. |

## Exercícios para assumir o domínio do código

1. Adicione um teste que reserve duas vagas e confirme que o cancelamento devolve duas.
2. Implemente revogação de chaves preservando o histórico do cliente; escreva primeiro o teste de acesso revogado.
3. Escreva um teste de duas conexões usando a mesma chave e confirme que há só uma reserva.
4. Adicione uma política de limite por cliente e explique como ela interage com a transação.
5. Faça uma alteração pequena por commit e registre o motivo no texto do commit.

Apresente as partes que você consegue explicar e modificar. Se perguntarem sobre ferramentas utilizadas, descreva com transparência a assistência de IA e a validação que você mesmo realizou. Não substitua o entendimento por um roteiro decorado.

## Descrição curta para a seção Projetos do LinkedIn

**ReserveFlow — API de reservas transacionais**

Projeto de backend em Node.js e SQLite com autenticação por API key, controle de capacidade, idempotência, cancelamento e auditoria. Inclui testes de concorrência com conexões independentes, rollback e persistência, documentação OpenAPI e configuração de integração contínua.

Use a descrição depois de executar a demonstração e compreender as decisões. O repositório é o material de apoio; a entrevista avalia também seu raciocínio e sua capacidade de evoluí-lo.
