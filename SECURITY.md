# Security Policy

## Reporting Security Issues

Please do not open public issues for vulnerabilities, leaked secrets, or deployment details that could expose live infrastructure.

Report security issues privately to the repository maintainers.

## Sensitive Deployment Data

Do not commit:

- `runtime.jsonc` from a live deployment.
- Reality private keys.
- Subscription tokens.
- User UUIDs from production profiles.
- Production `.env` files.
- VPS IP addresses or domains that are not intended to be public.
- Generated runtime config from a live deployment.

The files in `config/examples/` contain placeholders only. Replace them locally for your deployment and keep the edited files outside version control.
