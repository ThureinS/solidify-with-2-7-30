FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
# --ignore-scripts skips postinstall (`prisma generate`) -- the worker never
# touches the database, so it has no need for the Prisma client.
# --omit=dev skips devDependencies (prisma CLI, vitest, nodemon...) --
# worker.js only needs bullmq, ioredis, and nodemailer to run.
RUN npm install --ignore-scripts --omit=dev

COPY worker.js ./

CMD ["node", "worker.js"]
