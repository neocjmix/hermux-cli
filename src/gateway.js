#!/usr/bin/env node
'use strict';

// Skeleton: gateway composition root
// See docs/COMPONENT_CONTRACTS.md § 4 (gateway)
// See docs/specs/ADAPTER_STRATEGY_DI_SPEC.md § composition root
//
// BOUNDARY CONTRACTS:
//   - MUST NOT import from providers/downstream/* directly (use DeliveryAdapter)
//   - MUST NOT import from providers/upstream/* directly (use AgentRuntimeAdapter)
//   - MUST NOT contain channel/provider-specific logic
//   - MUST NOT pass transport limits (e.g. maxLen) to upstream
//   - MUST NOT parse raw upstream event types (use EventNormalizer canonical types)
//
// This file is the composition root: it wires adapters together via DI.
// All provider-specific code lives in src/providers/*/.

throw new Error('NOT_IMPLEMENTED: gateway');
