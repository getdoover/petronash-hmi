import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit

log = logging.getLogger(__name__)


def dev_mode_from_env() -> bool:
    """Whether dev mode is enabled via the PETRONASH_DEV_MODE environment variable.

    Enabling dev mode renders the on-screen alarm-testing toolbar. Using an env
    flag means the real app can be launched in test mode without any code change
    (e.g. `PETRONASH_DEV_MODE=1`), and it stays off by default in production.
    """
    return os.environ.get("PETRONASH_DEV_MODE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _opt_float(value: Any) -> Optional[float]:
    """Coerce to float, passing None through (None means "no data")."""
    return None if value is None else float(value)


def _opt_bool(value: Any) -> Optional[bool]:
    """Coerce to bool, passing None through (None means "no data")."""
    return None if value is None else bool(value)


def _opt_str(value: Any) -> Optional[str]:
    """Coerce to str, passing None through (None means "no data")."""
    return None if value is None else str(value)


class DashboardData:
    """Container for the DashboardData v2 payload sent on `data_update`.

    Every reading defaults to None, meaning "no data" — the UI must render a
    placeholder (e.g. "—") for None, never 0. Updates carry None explicitly to
    clear a reading (e.g. a sensor went offline); absent keys leave the current
    value untouched.
    """

    def __init__(self):
        # Pump states (from the pump controller app's tags; None = unknown)
        self.pump_1_on: Optional[bool] = None
        self.pump_2_on: Optional[bool] = None

        # Pressure (shared sensor)
        self.pressure_value: Optional[float] = None
        self.pressure_units: Optional[str] = None
        self.pressure_high_alarm: Optional[float] = None

        # Flow (shared sensor)
        self.flow_value: Optional[float] = None
        self.flow_units: Optional[str] = None
        self.flow_high_alarm: Optional[float] = None
        self.flow_low_alarm: Optional[float] = None

        # Volume totaliser (from the pump controller app). volume_total is the
        # grand total across all segments; volume_segment_total is the running
        # total for the currently-selected segment ("pipeline").
        self.volume_total: Optional[float] = None
        self.volume_segment_total: Optional[float] = None
        self.volume_units: str = "units"

        # Currently-selected segment ("pipeline") name, from the pump
        # controller (which mirrors the segmenter app's selection).
        self.segment_name: Optional[str] = None

        # Tank level
        self.tank_percent: Optional[float] = None
        self.tank_level_mm: Optional[float] = None
        # Tank capacity (from the level sensor's deployment_config; dumb
        # pass-through — the time-to-empty math lives entirely in hmi-core.js)
        self.tank_capacity_value: Optional[float] = None
        self.tank_capacity_units: Optional[str] = None
        # Tank alarm setpoint(s), already in display units (the level sensor's
        # alarm_source decides whether that is %, a volume or a length).
        self.tank_high_alarm: Optional[float] = None
        self.tank_low_alarm: Optional[float] = None
        self.tank_alarm_units: Optional[str] = None

        # Display units ("mm" or "inch") for length readings; defaults to inches
        self.length_unit: str = "inch"

        # Alerts (from the pump controller app; plain booleans, not "no data")
        self.unexpected_flow_alert: bool = False
        self.low_flow_alert: bool = False
        self.low_tank_time_alert: bool = False

        # System data
        self.timestamp: datetime = datetime.now(timezone.utc)
        self.system_status: str = "running"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to the DashboardData v2 dictionary for JSON serialization."""
        return {
            "pumps": {
                "pump_1": {"on": self.pump_1_on},
                "pump_2": {"on": self.pump_2_on},
            },
            "pressure": {
                "value": self.pressure_value,
                "units": self.pressure_units,
                "high_alarm": self.pressure_high_alarm,
            },
            "flow": {
                "value": self.flow_value,
                "units": self.flow_units,
                "high_alarm": self.flow_high_alarm,
                "low_alarm": self.flow_low_alarm,
            },
            "volume": {
                "total": self.volume_total,
                "segment_total": self.volume_segment_total,
                "units": self.volume_units,
            },
            "segment": {
                "name": self.segment_name,
            },
            "tank": {
                "percent": self.tank_percent,
                "level_mm": self.tank_level_mm,
                "capacity": {
                    "value": self.tank_capacity_value,
                    "units": self.tank_capacity_units,
                },
                "high_alarm": self.tank_high_alarm,
                "low_alarm": self.tank_low_alarm,
                "alarm_units": self.tank_alarm_units,
            },
            "units": {
                "length": self.length_unit,
            },
            "alerts": {
                "unexpected_flow": self.unexpected_flow_alert,
                "low_flow": self.low_flow_alert,
                "low_tank_time": self.low_tank_time_alert,
            },
            "system": {
                "timestamp": self.timestamp.isoformat(),
                "status": self.system_status,
            },
        }

    def update_from_dict(self, data: Dict[str, Any]):
        """Update from a (partial) v2 dictionary.

        Keys present with a None value clear the reading to "no data"; keys
        absent from the update keep their current value.
        """
        if "pumps" in data and isinstance(data["pumps"], dict):
            pumps = data["pumps"]
            if isinstance(pumps.get("pump_1"), dict) and "on" in pumps["pump_1"]:
                self.pump_1_on = _opt_bool(pumps["pump_1"]["on"])
            if isinstance(pumps.get("pump_2"), dict) and "on" in pumps["pump_2"]:
                self.pump_2_on = _opt_bool(pumps["pump_2"]["on"])

        if "pressure" in data and isinstance(data["pressure"], dict):
            pressure = data["pressure"]
            if "value" in pressure:
                self.pressure_value = _opt_float(pressure["value"])
            if "units" in pressure:
                self.pressure_units = _opt_str(pressure["units"])
            if "high_alarm" in pressure:
                self.pressure_high_alarm = _opt_float(pressure["high_alarm"])

        if "flow" in data and isinstance(data["flow"], dict):
            flow = data["flow"]
            if "value" in flow:
                self.flow_value = _opt_float(flow["value"])
            if "units" in flow:
                self.flow_units = _opt_str(flow["units"])
            if "high_alarm" in flow:
                self.flow_high_alarm = _opt_float(flow["high_alarm"])
            if "low_alarm" in flow:
                self.flow_low_alarm = _opt_float(flow["low_alarm"])

        if "volume" in data and isinstance(data["volume"], dict):
            volume = data["volume"]
            if "total" in volume:
                self.volume_total = _opt_float(volume["total"])
            if "segment_total" in volume:
                self.volume_segment_total = _opt_float(volume["segment_total"])
            if "units" in volume and volume["units"] is not None:
                self.volume_units = str(volume["units"])

        if "segment" in data and isinstance(data["segment"], dict):
            if "name" in data["segment"]:
                self.segment_name = _opt_str(data["segment"]["name"])

        if "tank" in data and isinstance(data["tank"], dict):
            tank = data["tank"]
            if "percent" in tank:
                self.tank_percent = _opt_float(tank["percent"])
            if "level_mm" in tank:
                self.tank_level_mm = _opt_float(tank["level_mm"])
            if isinstance(tank.get("capacity"), dict):
                capacity = tank["capacity"]
                if "value" in capacity:
                    self.tank_capacity_value = _opt_float(capacity["value"])
                if "units" in capacity:
                    self.tank_capacity_units = _opt_str(capacity["units"])
            if "high_alarm" in tank:
                self.tank_high_alarm = _opt_float(tank["high_alarm"])
            if "low_alarm" in tank:
                self.tank_low_alarm = _opt_float(tank["low_alarm"])
            if "alarm_units" in tank:
                self.tank_alarm_units = _opt_str(tank["alarm_units"])

        if "units" in data and isinstance(data["units"], dict):
            units = data["units"]
            if units.get("length") is not None:
                self.length_unit = str(units["length"])

        if "alerts" in data and isinstance(data["alerts"], dict):
            alerts = data["alerts"]
            if "unexpected_flow" in alerts:
                self.unexpected_flow_alert = bool(alerts["unexpected_flow"])
            if "low_flow" in alerts:
                self.low_flow_alert = bool(alerts["low_flow"])
            if "low_tank_time" in alerts:
                self.low_tank_time_alert = bool(alerts["low_tank_time"])

        if "system" in data and isinstance(data["system"], dict):
            system = data["system"]
            if system.get("status") is not None:
                self.system_status = str(system["status"])

        self.timestamp = datetime.now(timezone.utc)


class PetronashDashboard:
    """Flask dashboard with WebSocket support for the Petronash HMI.

    Strictly read-only: no socket event mutates any state beyond connection
    bookkeeping. All control lives in the pump controller app's cloud UI.
    """

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 8091,
        debug: bool = False,
        dev_mode: bool = None,
    ):
        self.host = host
        self.port = port
        self.debug = debug
        # dev_mode renders an on-screen dev toolbar for manually triggering alarms.
        # When not passed explicitly it's controlled by the PETRONASH_DEV_MODE env flag,
        # so any way of launching the app (real container or local runner) can opt in.
        self.dev_mode = dev_mode_from_env() if dev_mode is None else dev_mode

        # Create Flask app
        self.app = Flask(__name__, template_folder="templates", static_folder="static")
        self.app.config["SECRET_KEY"] = "petronash_dashboard_secret_key"

        # Create SocketIO instance
        self.socketio = SocketIO(self.app, cors_allowed_origins="*")

        # Dashboard data container
        self.data = DashboardData()

        # Connection tracking
        self.connected_clients = set()

        # Setup routes and event handlers
        self._setup_routes()
        self._setup_socket_events()

        # Background thread for data updates
        self._update_thread = None
        self._running = False

    def _setup_routes(self):
        """Setup Flask routes."""

        @self.app.route("/")
        def index():
            return render_template("dashboard.html", dev_mode=self.dev_mode)

        @self.app.route("/api/data")
        def get_data():
            """REST API endpoint to get current data."""
            return self.data.to_dict()

        @self.app.route("/api/health")
        def health():
            """Health check endpoint."""
            return {
                "status": "healthy",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

    def _setup_socket_events(self):
        """Setup WebSocket event handlers (read-only — no mutating handlers)."""

        @self.socketio.on("connect")
        def handle_connect():
            """Handle client connection."""
            self.connected_clients.add(request.sid)
            log.info(f"Client connected: {request.sid}")
            log.info(f"Total connected clients: {len(self.connected_clients)}")

            # Send current data to newly connected client
            emit("data_update", self.data.to_dict())

        @self.socketio.on("disconnect")
        def handle_disconnect():
            """Handle client disconnection."""
            self.connected_clients.discard(request.sid)
            log.info(f"Client disconnected: {request.sid}")
            log.info(f"Total connected clients: {len(self.connected_clients)}")

        @self.socketio.on("request_data")
        def handle_data_request():
            """Handle explicit data request from client."""
            emit("data_update", self.data.to_dict())

    def broadcast_update(self):
        """Broadcast data update to all connected clients."""
        if self.connected_clients:
            self.socketio.emit("data_update", self.data.to_dict())

    def update_data(self, **kwargs):
        """Update dashboard data and broadcast to clients."""
        try:
            # Update data container
            if kwargs:
                self.data.update_from_dict(kwargs)
                self.broadcast_update()
                log.debug(f"Dashboard data updated: {kwargs}")
        except Exception as e:
            log.error(f"Error updating dashboard data: {e}")

    def start(self):
        """Start the dashboard server."""
        log.info(f"Starting Petronash Dashboard on {self.host}:{self.port}")
        self._running = True

        # Start background update thread
        self._update_thread = threading.Thread(
            target=self._background_updates, daemon=True
        )
        self._update_thread.start()

        # Start Flask-SocketIO server (disable debug mode for threading compatibility)
        self.socketio.run(
            self.app,
            host=self.host,
            port=self.port,
            debug=False,
            allow_unsafe_werkzeug=True,
        )

    def _background_updates(self):
        """Background thread for periodic updates and health monitoring."""
        while self._running:
            try:
                # Update system timestamp
                self.data.timestamp = datetime.now(timezone.utc)

                # Send periodic heartbeat to clients
                if self.connected_clients:
                    self.socketio.emit(
                        "heartbeat", {"timestamp": self.data.timestamp.isoformat()}
                    )

                time.sleep(1)  # Update every second
            except Exception as e:
                log.error(f"Error in background updates: {e}")
                time.sleep(5)

    def stop(self):
        """Stop the dashboard server."""
        log.info("Stopping Petronash Dashboard")
        self._running = False
        if self._update_thread and self._update_thread.is_alive():
            self._update_thread.join(timeout=5)


class DashboardInterface:
    """Interface class to integrate dashboard with Application class."""

    def __init__(self, dashboard: PetronashDashboard):
        self.dashboard = dashboard
        self._server_thread = None

    def start_dashboard(self):
        """Start dashboard in a separate thread."""
        if self._server_thread and self._server_thread.is_alive():
            log.warning("Dashboard is already running")
            return

        self._server_thread = threading.Thread(
            target=self._dashboard_thread_start, daemon=True
        )
        self._server_thread.start()
        log.info("Dashboard started in background thread")

    def _dashboard_thread_start(self):
        """Thread-safe dashboard startup."""
        try:
            self.dashboard.start()
        except Exception as e:
            log.error(f"Dashboard startup failed: {e}")
            # Dashboard will fall back gracefully

    def stop_dashboard(self):
        """Stop the dashboard."""
        self.dashboard.stop()
        if self._server_thread and self._server_thread.is_alive():
            self._server_thread.join(timeout=5)
        log.info("Dashboard stopped")

    def update_system_status(self, status: str):
        """Update system status."""
        self.dashboard.update_data(system={"status": status})
