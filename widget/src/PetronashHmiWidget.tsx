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
}

function PetronashHmiInner({ uiElement }: { uiElement?: UiRemoteComponent }) {
  const params = useRemoteParams();
  const agentId = params?.agentId;
  const appKey = uiElement?.app_key ?? "petronash_hmi";

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
    hmiRef.current = createHmi(rootRef.current);
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
