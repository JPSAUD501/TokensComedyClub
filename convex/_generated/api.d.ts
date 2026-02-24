/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as ai from "../ai.js";
import type * as constants from "../constants.js";
import type * as engine from "../engine.js";
import type * as engineRunner from "../engineRunner.js";
import type * as history from "../history.js";
import type * as http from "../http.js";
import type * as live from "../live.js";
import type * as models from "../models.js";
import type * as platformViewers from "../platformViewers.js";
import type * as rounds from "../rounds.js";
import type * as state from "../state.js";
import type * as usage from "../usage.js";
import type * as usageBootstrap from "../usageBootstrap.js";
import type * as usageBootstrapRunner from "../usageBootstrapRunner.js";
import type * as viewerCount from "../viewerCount.js";
import type * as viewers from "../viewers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  ai: typeof ai;
  constants: typeof constants;
  engine: typeof engine;
  engineRunner: typeof engineRunner;
  history: typeof history;
  http: typeof http;
  live: typeof live;
  models: typeof models;
  platformViewers: typeof platformViewers;
  rounds: typeof rounds;
  state: typeof state;
  usage: typeof usage;
  usageBootstrap: typeof usageBootstrap;
  usageBootstrapRunner: typeof usageBootstrapRunner;
  viewerCount: typeof viewerCount;
  viewers: typeof viewers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
