# Dograh Tantei

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + TypeScript local UI, Node local controller embedding Pi SDK, Python audio worker. User chose direct implementation of the usable interface. Local browser interface is a control surface; audio does not require microphone access or two browser pages talking to each other.

## Users

Voice-agent builders and colleagues who clone the repository and use their own Dograh accounts and model credentials.

## Product Purpose

Run concurrent Japanese voice tests, capture stochastic failures with playable timestamp evidence, and use embedded Pi to improve selected workflow drafts and run regressions.

## Operating Context

Primary workflow example: Taxi Ride Demo (dev). Users enter natural-language test requirements at run time, allocate five calls to one task and five to another, and receive continuous separate findings. GPT-Live 1 is the required simulated caller; Pi uses Codex subscription OAuth or an OpenAI API key.

## Capabilities and Constraints

Local files, no database, no separately deployed remote backend. Shared 10-call pool, task limits and stop controls. Record both audio tracks and real elapsed timing. Independent business assertions. Never fabricate test results. Preserve workflow versions and edits. Publish is outside draft-update tools.

## Evidence on Hand

Current module boundaries and integration contracts are documented in `docs/architecture.md`, `docs/dograh-connection.md`, and `docs/pi-integration.md`. The production visual system is documented in `DESIGN.md`.

## Product Principles

Evidence before conclusions. Visible task ownership. Small controlled edits. Independent credentials per installation. Honest empty states and connection errors.
