#!/usr/bin/env bash
# ============================================================================
# Подготовка сервера базы данных сайта «Стиль» (VPS в России, Ubuntu 24.04,
# от 1 ГБ памяти) — 2026-10-23. Запускается один раз от root на чистом сервере:
#   scp db/postgres/schema.sql scripts/setup-server.sh root@IP:/root/
#   ssh root@IP 'bash /root/setup-server.sh'
#
# Что делает:
#   - PostgreSQL 16, база stil и пользователь stil со случайным паролем;
#   - шифрование соединений: свой сертификат на IP сервера, без шифрования
#     подключиться нельзя (hostnossl → reject);
#   - брандмауэр: открыты только SSH и порт базы; fail2ban от перебора SSH;
#   - вход по SSH только по ключу (если ключ уже добавлен);
#   - автообновления безопасности; файл подкачки 1 ГБ;
#   - резервная копия базы каждую ночь в /var/backups/stil (хранятся 14 дней);
#   - каждые 5 минут — сверка «зависших» оплат с Robokassa (запрос к сайту);
#   - применяет схему /root/schema.sql.
# В конце пишет строку подключения и сертификат в /root/stil-connection.txt
# (только для root) — их нужно вставить в Vercel: DATABASE_URL и DATABASE_CA.
# Повторный запуск ничего не ломает и пароль не меняет.
# ============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Запускать от root"; exit 1; fi
SCHEMA=/root/schema.sql
[ -f "$SCHEMA" ] || { echo "Нет $SCHEMA — сначала скопируйте db/postgres/schema.sql"; exit 1; }

IP=$(curl -4 -fsS https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo "== IP сервера: $IP"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q postgresql postgresql-contrib ufw fail2ban unattended-upgrades openssl curl

# ---- подкачка: на 1 ГБ памяти без неё Postgres может упасть при всплеске ----
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

PGVER=$(ls /etc/postgresql | sort -V | tail -1)
PGCONF=/etc/postgresql/$PGVER/main
echo "== PostgreSQL $PGVER"

# ---- сертификат на IP сервера (10 лет) ----
CERT_DIR=$PGCONF/ssl
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/server.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" \
    -subj "/CN=$IP" -addext "subjectAltName=IP:$IP"
fi
chown -R postgres:postgres "$CERT_DIR"
chmod 600 "$CERT_DIR/server.key"

# ---- настройки Postgres (маленький сервер) ----
cat > "$PGCONF/conf.d/stil.conf" <<CONF
listen_addresses = '*'
ssl = on
ssl_cert_file = '$CERT_DIR/server.crt'
ssl_key_file = '$CERT_DIR/server.key'
ssl_min_protocol_version = 'TLSv1.2'
password_encryption = scram-sha-256
max_connections = 60
shared_buffers = 128MB
effective_cache_size = 384MB
work_mem = 4MB
maintenance_work_mem = 64MB
log_connections = off
log_min_duration_statement = 2000
CONF

# ---- кто может подключаться: локально — служебный postgres, снаружи — только stil и только с шифрованием ----
HBA=$PGCONF/pg_hba.conf
if ! grep -q 'stil-managed' "$HBA"; then
  cp "$HBA" "$HBA.orig"
  cat > "$HBA" <<HBA
# stil-managed (scripts/setup-server.sh)
local   all       postgres                 peer
local   all       all                      scram-sha-256
host    all       all       127.0.0.1/32   scram-sha-256
hostnossl all     all       0.0.0.0/0      reject
hostssl stil      stil      0.0.0.0/0      scram-sha-256
HBA
fi
systemctl restart postgresql

# ---- база и пользователь ----
CONN=/root/stil-connection.txt
if [ ! -f "$CONN" ]; then
  PASS=$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 40)
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'stil') then
    create role stil login password '$PASS';
  end if;
end \$\$;
SQL
  sudo -u postgres psql -tAc "select 1 from pg_database where datname='stil'" | grep -q 1 || sudo -u postgres createdb -O stil stil
  {
    echo "DATABASE_URL=postgres://stil:$PASS@$IP:5432/stil"
    echo
    echo "DATABASE_CA (весь текст ниже, вместе со строками BEGIN/END):"
    cat "$CERT_DIR/server.crt"
  } > "$CONN"
  chmod 600 "$CONN"
fi
sudo -u postgres psql -q -c "revoke all on database stil from public"
PGPASSWORD="$(sed -n 's#^DATABASE_URL=postgres://stil:\([^@]*\)@.*#\1#p' "$CONN")" \
  psql -h 127.0.0.1 -U stil -d stil -v ON_ERROR_STOP=1 -q -f "$SCHEMA"
echo "== схема применена"

# ---- брандмауэр и защита SSH ----
ufw allow OpenSSH >/dev/null
ufw allow 5432/tcp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null
if [ -s /root/.ssh/authorized_keys ]; then
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  rm -f /etc/ssh/sshd_config.d/50-cloud-init.conf
  systemctl reload ssh || systemctl reload sshd || true
  echo "== вход по SSH — только по ключу"
fi

# ---- ночная резервная копия ----
mkdir -p /var/backups/stil && chown postgres:postgres /var/backups/stil && chmod 700 /var/backups/stil
cat > /etc/cron.d/stil-backup <<'CRON'
30 2 * * * postgres pg_dump -Fc stil > /var/backups/stil/stil-$(date +\%F).dump && find /var/backups/stil -name 'stil-*.dump' -mtime +14 -delete
CRON

# ---- сверка «зависших» оплат с Robokassa каждые 5 минут (lib/reconcile.js, api/files.js) ----
cat > /etc/cron.d/stil-reconcile <<'CRON'
*/5 * * * * root curl -s -m 60 -o /dev/null 'https://www.stil-shag.ru/api/files?action=reconcile'
CRON

echo
echo "== Готово. Данные для Vercel — в $CONN (cat $CONN)"
