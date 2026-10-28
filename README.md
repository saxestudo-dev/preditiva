# Preditiva & Alertas Antecipados — pacote inicial integrado

**Status:** base técnica de desenvolvimento (v0.1), não homologada para produção. Este pacote não publica o sistema na internet nem cria contas institucionais por conta própria.

## O que vem neste pacote

- PWA responsiva para computador, Android e iPhone.
- API web com sessão autenticada e cookies `HttpOnly`.
- PostgreSQL para empenhos, usuários, anexos, auditoria e registro de notificações.
- Perfis: `requisitante`, `ordenador` e `admin`.
- Upload privado de PDFs/JPG/PNG/WEBP.
- Histórico de ações e consulta de anexos com autorização.
- Agendamento inicial de alertas de prazo por e-mail e push.
- `docker-compose.yml` para ambiente de desenvolvimento.
- Cópia da versão HTML local v1.1 em `legacy/` para referência/migração.

## Limitações importantes

1. Esta é uma **base inicial**, não uma implantação institucional concluída. Deve passar por revisão de segurança, testes, homologação e autorização da TI.
2. A importação automática do SIAFI/SAG/Tesouro Gerencial não está implementada.
3. O calendário de feriados não está integrado. O cálculo de 3 dias úteis exclui sábados e domingos; feriados exigem adaptação.
4. O job de alertas é uma primeira implementação. Antes de produção, a TI deve testar deduplicação, fusos horários, retentativas, monitoramento e regras de notificação.
5. Os alertas só serão enviados se SMTP e VAPID estiverem configurados. O push exige que o usuário habilite notificações em cada aparelho.
6. O aplicativo não deve receber dados reais até que HTTPS, acesso remoto seguro, política de senhas, backup/restauração, logs, proteção de arquivos, retenção e resposta a incidentes estejam aprovados.
7. A interface inicial tem funções essenciais de cadastro, consulta, atualização, anexos, entrega e histórico. Recursos mais avançados da v1.1 (importação/exportação CSV, relatórios e todas as telas anteriores) ainda precisam ser portados para a interface integrada.

## Pré-requisitos para teste local

- Docker Desktop ou Docker Engine com Compose.
- Node.js 22+ (necessário se for executar comandos npm fora do contêiner).
- Acesso administrativo à máquina de desenvolvimento.

## Iniciar o ambiente de desenvolvimento

1. Copie `.env.example` para `.env`.
2. Gere um `SESSION_SECRET` longo e aleatório. Troque também a senha de banco em `POSTGRES_PASSWORD`.
3. Para teste local, mantenha `COOKIE_SECURE=false` apenas em `http://localhost`. Em produção, use `COOKIE_SECURE=true` atrás de HTTPS.
4. Execute:

```bash
docker compose up --build -d
docker compose logs -f app
```

5. Crie o primeiro administrador usando uma senha longa, fornecida somente no terminal:

```bash
docker compose exec app sh
NEW_USER_PASSWORD='use-uma-senha-longa-de-pelo-menos-14-caracteres' \
  npm run create-user -- administrador@instituicao.gov.br "Administrador do Sistema" admin
exit
```

Não reutilize o exemplo de senha. Não envie senha, token, arquivo `.env` ou credencial para o ChatGPT ou para terceiros.

6. Acesse `http://localhost:3000` para teste local. Não exponha a porta diretamente à internet.

## Configuração de notificações

### E-mail

Preencha as variáveis `SMTP_*` com os parâmetros fornecidos pela TI. Use apenas um relay institucional autorizado. Teste entregabilidade e registro de falhas antes de homologar.

### Push

Gere as chaves VAPID em ambiente seguro:

```bash
npx web-push generate-vapid-keys
```

Preencha `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT`. A chave privada nunca deve ser publicada. Reinicie o serviço. Cada usuário ativa push no dispositivo, com permissão do sistema operacional/navegador.

## Publicação para acesso remoto

**Não publique diretamente pela porta 3000.** A equipe de TI deve:
- aprovar a classificação dos dados e a hospedagem;
- disponibilizar HTTPS por proxy reverso institucional;
- escolher VPN/acesso privado ou outra solução corporativa autorizada;
- configurar `PUBLIC_BASE_URL`, `COOKIE_SECURE=true` e `TRUST_PROXY=true` quando aplicável;
- restringir portas do banco e armazenamento à rede interna;
- configurar firewall, logs, monitoramento, atualização de dependências, backups criptografados e testes de restauração;
- revisar sessão, CSRF/origin, autorização, limites de upload, antivírus/varredura de arquivos e política de retenção;
- homologar alertas, feriados e regras administrativas com os responsáveis pelo processo.

## Banco de dados e migração

O esquema inicial é `server/schema.sql`. A v1.1 local guarda registros em `localStorage` e anexos como data URLs. A migração precisa ser feita por exportação de backup JSON da v1.1, transformação dos campos e importação por ferramenta controlada. **Não existe ainda importador automático do backup local neste pacote.** Faça cópia de segurança e valide uma amostra antes de migrar dados oficiais.

## Regras de prazo

- Comunicação: 3 dias úteis após emissão, excluindo sábados e domingos.
- Entrega: 30 ou 45 dias corridos após a data registrada da comunicação.
- Feriados nacionais, estaduais, municipais e pontos facultativos não são aplicados automaticamente nesta versão.

As regras devem ser confirmadas pela unidade antes de uso operacional.

## Estrutura

```text
public/      PWA responsiva
server/      API, sessões, notificações e schema PostgreSQL
scripts/     criação controlada de usuários
legacy/      aplicativo local v1.1 original
```
