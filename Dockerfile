FROM nginxinc/nginx-unprivileged:stable-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html app.js styles.css /usr/share/nginx/html/
COPY admin/index.html /usr/share/nginx/html/admin/index.html
COPY csp/index.html /usr/share/nginx/html/csp/index.html
COPY csp/admin/index.html /usr/share/nginx/html/csp/admin/index.html
COPY logistics/index.html logistics/app.js logistics/styles.css /usr/share/nginx/html/logistics/
COPY logistics/admin/index.html logistics/admin/admin-app.js /usr/share/nginx/html/logistics/admin/
COPY fines/index.html fines/app.js fines/styles.css /usr/share/nginx/html/fines/
COPY fines/admin/index.html fines/admin/admin-app.js /usr/share/nginx/html/fines/admin/

EXPOSE 8080
