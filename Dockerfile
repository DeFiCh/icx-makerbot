FROM denoland/deno:alpine-1.12.1

WORKDIR /app

COPY . .

CMD ["run", "--allow-all", "index.js"]