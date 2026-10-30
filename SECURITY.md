# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | Yes |
| < 0.2 | No |

## Reporting a vulnerability

Please use **GitHub Security Advisories** ("Report a vulnerability") for this
repository. Do not open a public issue for:

- token handling or authentication bypass,
- arbitrary file write/read through the Runtime API,
- EDA write-path authorization bypass,
- evidence/gate forgery,
- credential leakage (Keychain/provider keys),
- command injection or path traversal.

Include: affected version, macOS version, reproduction steps, and impact.
Please avoid attaching real customer boards or secrets; redact paths and
identifiers.

## Scope

In scope: this repository's code (console, Tauri shell, Runtime, scripts).
Out of scope: vulnerabilities in third-party EDA editors, vendor APIs, or
Apple/macOS itself; report those to the respective vendor.

## Design promises (not vulnerabilities)

- `/api/*` returning `401` for external processes without the per-launch token
  is intentional.
- The release gate being blocked when evidence is missing is intentional.
- Demo mode not performing real hardware actions is intentional.

## 中文摘要

请通过 GitHub Security Advisories 私密报告漏洞，不要开公开 issue。范围包括
令牌/鉴权、Runtime 文件读写、EDA 写板授权、证据/门禁伪造、凭据泄露、命令注入
与路径穿越。请勿附带真实客户板文件或密钥。第三方 EDA 厂商、macOS 自身的问题请
报给对应厂商。
