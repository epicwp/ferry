#!/bin/bash
set -euo pipefail
grep -q ' db$' /etc/hosts || echo '127.0.0.1 db' >> /etc/hosts   # overlay wp-config uses DB_HOST 'db' (overlay.ts:47)
mkdir -p /data/www /data/mysql
chown -R www-data:www-data /data/www
mkdir -p /run/mysqld && chown mysql:mysql /run/mysqld   # not created by the wordpress base image; mariadbd needs it for its unix socket
[ -f /etc/ferry/sited-secret ] && chmod 600 /etc/ferry/sited-secret
if [ ! -d /data/mysql/mysql ]; then
  chown -R mysql:mysql /data/mysql
  mariadb-install-db --user=mysql --datadir=/data/mysql >/dev/null
  (mariadbd --user=mysql &) && for i in $(seq 1 30); do mysqladmin ping >/dev/null 2>&1 && break; sleep 1; done
  mysql -e "CREATE DATABASE IF NOT EXISTS db; CREATE USER IF NOT EXISTS 'db'@'%' IDENTIFIED BY 'db'; CREATE USER IF NOT EXISTS 'db'@'localhost' IDENTIFIED BY 'db'; GRANT ALL ON db.* TO 'db'@'%'; GRANT ALL ON db.* TO 'db'@'localhost'; FLUSH PRIVILEGES;"
  mysqladmin shutdown
fi
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
