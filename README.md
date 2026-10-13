# Skyfly

A lightweight platform for managing multiple businesses: workspaces, landing
pages and funnels, a product catalogue, customers, orders, payments and basic
analytics.

Skyfly is a standalone project. It has its own repository, dependencies,
database, secrets and (eventually) Render service. It shares nothing with any
other project.

## Stack

- Node.js 22, Express, server-rendered EJS views
- PostgreSQL (`pg`), plain SQL migrations in `migrations/`
- Sessions stored in Postgres (`express-session` + `connect-pg-simple`)
- Password hashing with Node's built-in scrypt
- Tests with `node:test` + `supertest`

## Local development

Requires Node 22+ and a local PostgreSQL server.

```sh
npm install
cp .env.example .env          # then set SESSION_SECRET (see comment in the file)
createdb skyfly_dev           # Skyfly's own local database
npm run migrate
npm run dev                   # http://localhost:3000
```

The first visit to `/signup` creates the owner account while
`ALLOW_SIGNUP=true`. Set it to `false` afterwards.

## Tests

Tests wipe and rebuild the database they run against, so they refuse to run
unless `DATABASE_URL` names a `*_test` database:

```sh
createdb skyfly_test
echo 'DATABASE_URL=postgres://localhost:5432/skyfly_test' > .env.test
npm test
```

## Environments

| | Development | Production |
|---|---|---|
| Config | `.env` (git-ignored) | Render environment variables |
| Database | local `skyfly_dev` | Skyfly's own Render Postgres |
| Start | `npm run dev` | `npm start` (after `npm run migrate`) |

`npm start` does not read `.env`; production config comes only from the host.

## Deployment

`render.yaml` describes Skyfly's own Render web service and database. It has
**not** been applied. Nothing is deployed until the owner reviews the plans and
costs and creates the Blueprint in Render.

## Layout

```
src/
  server.js        entrypoint
  app.js           Express app (routes, sessions, security headers)
  config.js        environment validation
  db.js            Postgres pool
  migrate.js       migration runner
  lib/             auth + password helpers
  routes/          auth, businesses
  views/           EJS templates
migrations/        SQL migrations, applied in order
test/              integration tests
```
