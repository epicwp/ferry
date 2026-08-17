# syntax=docker/dockerfile:1
ARG PHP_MINOR=8.2
FROM wordpress:php${PHP_MINOR}-apache
# The wordpress base gives us apache2 + php + the WP extension set; core files come from the clone, not the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      mariadb-server mariadb-client mariadb-client-compat supervisor curl ca-certificates less \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
    && chmod +x /usr/local/bin/wp \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
COPY docker/site-runtime/apache-docroot.conf /etc/apache2/sites-available/000-default.conf
COPY docker/site-runtime/ferry-binlog.cnf /etc/mysql/mariadb.conf.d/90-ferry-binlog.cnf
COPY docker/site-runtime/supervisord.conf /etc/supervisor/conf.d/ferry.conf
# sited: the workspace runs from source via tsx, mirroring ferry-server
WORKDIR /opt/ferry
COPY package.json package-lock.json ./
COPY ferry-sited/package.json ferry-sited/
RUN npm ci --workspace ferry-sited --include=dev
COPY ferry-sited ferry-sited
COPY docker/site-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
