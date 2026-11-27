# Security Policy

Archne is a peer-to-peer messenger, so security reports matter. Thank you for taking the time to send one.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Include:

- what you found and where (file, feature, or protocol message),
- steps to reproduce, and the version or commit you tested,
- the impact you think it has.

You can expect an acknowledgement within a few days. This is a small project run by one person, so fixes may take longer, but every report is read.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |
| Older | No |

## Good to know

- Archne has **not been independently security audited**. Do not rely on it as your only channel for high-risk communication.
- The private key is stored in `identity.json` with owner-only permissions and no extra encryption. Protection with the system secure storage is planned.
- Sites hosted by other people run isolated, but treat a stranger's site like any untrusted web page.

See the [README](README.md#-limitations-and-roadmap) for the full list of known limitations.
