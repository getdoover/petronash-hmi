import "../../src/petronash_hmi/static/css/hmi-core.css";

import { useEffect, useMemo, useRef } from "react";

import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import { useRemoteParams } from "customer_site/useRemoteParams";

import { useAgentChannel } from "doover-js/react";

import {
  createHmi,
  type HmiHandle,
} from "../../src/petronash_hmi/static/js/hmi-core.js";
import { assembleDashboardData } from "./lib/assembleDashboardData";

/**
 * Petronash HMI cloud widget.
 *
 * A thin React shell around the SAME framework-free render core the
 * device-local dashboard uses (src/petronash_hmi/static/js/hmi-core.js):
 * doover-js hooks keep the agent's `tag_values` / `ui_cmds` /
 * `deployment_config` aggregates live over the host's gateway WebSocket, the
 * data adapter (lib/assembleDashboardData.ts) folds them into a
 * DashboardData v2 dict, and hmi-core renders it into a ref'd div.
 *
 * Installed on the pump-skid device agent itself — see widget/README.md for
 * the doover_config.json wiring (widget: field, ui_schema uiRemoteComponent,
 * dv_app_position).
 */

interface UiRemoteComponent {
  /** This install's app key — its config block lives under it in deployment_config. */
  app_key?: string;
  /** Element name. In the DDA local widget host this is the widget channel,
   *  `<app_key>_widget`, and app_key itself is not supplied. */
  name?: string;
}

const DEFAULT_APP_KEY = "petronash_hmi_1";

/**
 * Resolve this install's app_key across both widget hosts.
 *
 * The cloud interpreter supplies `uiElement.app_key` ($config.app().APP_KEY).
 * The device-agent local host (dda-agent) instead names the element after the
 * widget channel (`<app_key>_widget`) and passes the key only as a sibling
 * `applicationName` prop the federated component never receives — so we recover
 * app_key by stripping the `_widget` suffix. Without this the widget silently
 * falls back to default peer-app keys, which is only correct when the install
 * happens to use the defaults.
 */
function resolveAppKey(uiElement?: UiRemoteComponent): string {
  if (uiElement?.app_key) return uiElement.app_key;
  const name = uiElement?.name;
  if (typeof name === "string" && name.endsWith("_widget")) {
    return name.slice(0, -"_widget".length);
  }
  return DEFAULT_APP_KEY;
}

function PetronashHmiInner({ uiElement }: { uiElement?: UiRemoteComponent }) {
  const params = useRemoteParams();
  const agentId = params?.agentId;
  const appKey = resolveAppKey(uiElement);

  const { data: deploymentConfig } = useAgentChannel(
    agentId,
    "deployment_config",
  );
  const { data: tagValues, last_updated } = useAgentChannel(
    agentId,
    "tag_values",
  );
  const { data: uiCmds } = useAgentChannel(agentId, "ui_cmds");

  const rootRef = useRef<HTMLDivElement | null>(null);
  const hmiRef = useRef<HmiHandle | null>(null);

  const data = useMemo(
    () =>
      assembleDashboardData({
        appKey,
        deploymentConfig,
        tagValues,
        uiCmds,
        lastUpdated: last_updated,
      }),
    [appKey, deploymentConfig, tagValues, uiCmds, last_updated],
  );

  // Mount the render core once; RemoteHost may remount the lazy component,
  // so createHmi/destroy are idempotent against the same root div.
  useEffect(() => {
    if (!rootRef.current) {
      return;
    }
    // Cloud widget: the alert window stacks above the tiles (y-axis banner)
    // rather than overlaying them, so it never covers content in the host UI's
    // variable-height column. The local panel keeps the default z-axis overlay.
    hmiRef.current = createHmi(rootRef.current, { alertLayout: "inline" });
    return () => {
      hmiRef.current?.destroy();
      hmiRef.current = null;
    };
  }, []);

  useEffect(() => {
    hmiRef.current?.update(data);
  }, [data]);

  return <div ref={rootRef} style={{ padding: "8px" }} />;
}

const PetronashHmiWidget = (props: { uiElement?: UiRemoteComponent }) => (
  <RemoteComponentWrapper>
    <PetronashHmiInner {...props} />
  </RemoteComponentWrapper>
);

export default PetronashHmiWidget;
