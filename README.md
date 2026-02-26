# nakom-admin

Admin dashboard for [nakom.is](https://nakom.is) — chat analytics, on-demand RDS/pgvector, spam detection and blocking.

**Live:** https://admin.nakom.is
**Account:** nakom.is-admin (AWS eu-west-2)
**Licence:** CC0-1.0

## Architecture

<!-- drawio: docs/diagrams/architecture.drawio -->
![Architecture](docs/diagrams/architecture.svg)

## Stack deploy order

```
CertificateStack (us-east-1) → CognitoStack → CloudfrontStack → AnalyticsStack → ApiStack
```

## Development

```bash
# Infra
cd infra && npm install
AWS_PROFILE=nakom.is-admin cdk synth

# Web app
cd web && npm install && npm start
```

## Git hooks

draw.io files are auto-exported to SVG on commit. Activate with:

```bash
git config core.hooksPath .githooks
```
