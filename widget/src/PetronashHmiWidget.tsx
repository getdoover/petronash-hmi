import "../../src/petronash_hmi/static/css/hmi-core.css";

// Header brand logos, inlined as data URIs (see globals.d.ts / rsbuild.config)
// so the single-file ConcatenatePlugin bundle carries them with no emitted
// .png. The framework-free render core cannot import images, so the shell
// hands them to createHmi to build the header.
import aramcoLogo from "./assets/aramco_logo.png?inline";
import petronashLogo from "./assets/petronash_logo.png?inline";
import remoteCommandLogo from "./assets/remote_command_logo.png?inline";

import { useEffect, useMemo, useRef } from "react";

import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import { useRemoteParams } from "customer_site/useRemoteParams";

import { useAgentChannel } from "doover-js/react";

import {
  createHmi,
  type HmiHandle,
} from "../../src/petronash_hmi/static/js/hmi-core.js";
import {
  assembleDashboardData,
  resolvePeerApps,
} from "./lib/assembleDashboardData";
import {
  liveTagIds,
  overlayLiveValues,
  reconcileTankVolume,
} from "./lib/liveTags";
import { useLiveTags } from "./lib/useLiveTags";

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

/** The level sensor app's own block of deployment_config (its volume model lives there). */
function tankAppConfig(
  deploymentConfig: Record<string, unknown> | undefined,
  tankApp: string,
): Record<string, unknown> {
  const apps = deploymentConfig?.applications;
  const block =
    apps && typeof apps === "object"
      ? (apps as Record<string, unknown>)[tankApp]
      : undefined;
  return block && typeof block === "object" && !Array.isArray(block)
    ? (block as Record<string, unknown>)
    : {};
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

  // Live tags. The persisted tag_values aggregate only reaches the cloud
  // every 15 minutes unless the tag-owning app's own card is expanded, so the
  // widget claims its tiles' tags in the device's presence channel and
  // overlays the one-shot frames the apps stream back. The hook is a no-op
  // on the device-agent local host (its client is not a doover-js cloud
  // client — see isLiveCapableClient); the kiosk renders at loop rate from
  // local state regardless.
  const peers = useMemo(
    () => resolvePeerApps(appKey, deploymentConfig),
    [appKey, deploymentConfig],
  );
  const tagIds = useMemo(() => liveTagIds(peers), [peers]);
  const liveValues = useLiveTags({ agentId, tagIds });
  // Local arrival time of the aggregate we hold: a live value must be at
  // least this new to override it (deliberately keyed on object identity).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const aggregateAt = useMemo(() => Date.now(), [tagValues]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const hmiRef = useRef<HmiHandle | null>(null);

  const data = useMemo(() => {
    const live = overlayLiveValues(tagValues, liveValues, aggregateAt);
    // The level sensor streams level and percentage but (today) not volume;
    // re-derive the volume from the live level so the tank tile stays
    // self-consistent rather than pairing a live gauge with a stale figure.
    const tankConfig = tankAppConfig(deploymentConfig, peers.tankApp);
    const merged = reconcileTankVolume(
      live.tagValues,
      live.applied,
      peers.tankApp,
      tankConfig,
    );
    return assembleDashboardData({
      appKey,
      deploymentConfig,
      tagValues: merged,
      uiCmds,
      // While live frames are being applied the readings are seconds old even
      // though the aggregate has not moved, so the timestamp follows them.
      lastUpdated: live.liveAt ?? last_updated,
    });
  }, [
    appKey,
    deploymentConfig,
    peers,
    tagValues,
    liveValues,
    aggregateAt,
    uiCmds,
    last_updated,
  ]);

  // Mount the render core once; RemoteHost may remount the lazy component,
  // so createHmi/destroy are idempotent against the same root div.
  useEffect(() => {
    if (!rootRef.current) {
      return;
    }
    // Cloud widget: the alert window stacks above the tiles (y-axis banner)
    // rather than overlaying them, so it never covers content in the host UI's
    // variable-height column. The local panel keeps the default z-axis overlay.
    // The logos build the branded header above everything; the render core
    // cannot import images, so we pass the inlined data URIs in here.
    hmiRef.current = createHmi(rootRef.current, {
      alertLayout: "inline",
      logos: {
        petronash: petronashLogo,
        remoteCommand: remoteCommandLogo,
        aramco: aramcoLogo,
      },
    });
    return () => {
      hmiRef.current?.destroy();
      hmiRef.current = null;
    };
  }, []);

  useEffect(() => {
    hmiRef.current?.update(data);
  }, [data]);

  // Padding lives in hmi-core.css (.hmi-root) so compact mode can drop it.
  return <div ref={rootRef} />;
}

const PetronashHmiWidget = (props: { uiElement?: UiRemoteComponent }) => (
  <RemoteComponentWrapper>
    <PetronashHmiInner {...props} />
  </RemoteComponentWrapper>
);

export default PetronashHmiWidget;
