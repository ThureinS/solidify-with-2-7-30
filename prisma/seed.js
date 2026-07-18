const prisma = require('../src/lib/prisma');
const { DEV_USER_ID } = require('../src/lib/devUser');

async function main() {
  await prisma.user.upsert({
    where: { id: DEV_USER_ID },
    update: {},
    create: {
      id: DEV_USER_ID,
      email: 'dev@example.com',
      passwordHash: 'placeholder-until-part-5-auth',
    },
  });
  console.log('Seeded dev user.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
