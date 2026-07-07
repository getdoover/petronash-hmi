/**
 * SIA Local Control Dashboard JavaScript
 * Handles WebSocket communication and UI updates
 */

class Dashboard {
    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 2000;
        this.data = {};
        this.connectionErrorElement = null;
        
        this.initializeElements();
        this.initializeSocket();
        this.setupEventListeners();
    }
    
    initializeElements() {
        // Connection status
        this.connectionStatus = document.getElementById('connection-status');
        
        // Pump controls
        this.pumpState = document.getElementById('pump-state').querySelector('.state-value');

        // Pump 2 controls (only shown when a second pump app is configured)
        this.hmiGrid = document.querySelector('.hmi-grid');
        this.pump1Heading = document.getElementById('pump1-heading');
        this.pump2Section = document.getElementById('pump2-section');
        this.pump2State = document.getElementById('pump2-state').querySelector('.state-value');
        this.pump2Pressure = document.getElementById('pump2-pressure').querySelector('.value');

        // Tank controls
        this.tankLevelMm = document.getElementById('tank-level-mm').querySelector('.value');
        this.tankLevelUnit = document.getElementById('tank-level-mm').querySelector('.unit');
        this.tankLevelPercent = document.getElementById('tank-level-percent').querySelector('.value');
        this.tankProgress = document.getElementById('tank-progress');

        // Display units for length readings ("mm" or "inch"); raw value always stored in mm
        this.lengthUnit = 'inch';
        this.tankLevelRawMm = 0;

        // Skid controls
        this.skidFlow = document.getElementById('skid-flow').querySelector('.value');
        this.skidPressure = document.getElementById('skid-pressure').querySelector('.value');
        this.skidTotalFlow = document.getElementById('skid-total-flow').querySelector('.value');

        // Alarm setpoint readouts (display only for now)
        this.pressureHighAlarm = document.getElementById('pressure-high-alarm');
        this.pump2PressureHighAlarm = document.getElementById('pump2-pressure-high-alarm');
        this.flowHighAlarm = document.getElementById('flow-high-alarm');
        this.flowLowAlarm = document.getElementById('flow-low-alarm');
        // Tank low alarm: raw value always mm, displayed in the active length unit
        this.tankLevelLowAlarm = document.getElementById('tank-level-low-alarm');
        this.tankLevelLowAlarmUnit = document.getElementById('tank-level-low-alarm-unit');
        this.tankLevelLowAlarmRawMm = 0;
        
        this.systemStatus = document.getElementById('system-status')?.querySelector('.status-value');
        
        // Footer
        this.lastUpdate = document.getElementById('last-update');
        
        // Loading overlay
        this.loadingOverlay = document.getElementById('loading-overlay');

        // Fault popover
        this.faultPopover = document.getElementById('fault-popover');
        this.faultMessageList = document.getElementById('fault-message-list');
        this.faultInstructions = document.querySelector('.fault-popover-instructions');

        // Alarm popover (setpoint exceedance detected client-side)
        this.alarmPopover = document.getElementById('alarm-popover');
        this.alarmMessageList = document.getElementById('alarm-message-list');
        this.alarmDim = document.getElementById('alarm-dim');

        // Valve control popup
        this.valveControlPopup = document.getElementById('valve-control-popup');
    }
    
    initializeSocket() {
        try {
            this.socket = io();
            this.setupSocketEvents();
        } catch (error) {
            console.error('Failed to initialize socket:', error);
            this.showConnectionError();
        }
    }
    
    setupSocketEvents() {
        // Connection events
        this.socket.on('connect', () => {
            console.log('Connected to dashboard server');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.updateConnectionStatus(true);
            this.hideLoadingOverlay();
            this.hideConnectionError();
        });
        
        this.socket.on('disconnect', () => {
            console.log('Disconnected from dashboard server');
            this.isConnected = false;
            this.updateConnectionStatus(false);
            this.attemptReconnect();
        });
        
        this.socket.on('connect_error', (error) => {
            console.error('Connection error:', error);
            this.updateConnectionStatus(false);
            this.showConnectionError();
        });
        
        // Data events
        this.socket.on('data_update', (data) => {
            console.log('Received data update:', data);
            this.data = data;
            this.updateDashboard(data);
            // Extract timestamp from system data if available
            const timestamp = data.system?.timestamp || null;
            this.updateLastUpdateTime(timestamp);
        });
        
        this.socket.on('heartbeat', (data) => {
            console.log('Received heartbeat:', data);
            this.updateLastUpdateTime(data.timestamp);
        });
        
        this.socket.on('error', (error) => {
            console.error('Socket error:', error);
            this.showError(error.message || 'Unknown error occurred');
        });

        this.socket.on('pump_selection_changed', (data) => {
            console.log('Received pump selection change:', data);
            if (data.selected_pump) {
                this.setSelectedPump(data.selected_pump, true); // true = fromWebSocket
            }
        });

        this.socket.on('valve_control_popup', (data) => {
            console.log('Received valve control popup event');
            this.showValveControlPopup();
        });
    }
    
    setupEventListeners() {
        // Pump state buttons
        const pumpStateButtons = document.querySelectorAll('.state-btn[data-state]');
        pumpStateButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const state = e.target.getAttribute('data-state');
                this.changePumpState(state);
            });
        });
        
        // Dev toolbar (only present when the server runs in dev mode)
        const devButtons = document.querySelectorAll('.dev-btn[data-alarm]');
        devButtons.forEach((button) => {
            button.addEventListener('click', (e) => {
                this.devTriggerAlarm(e.currentTarget.getAttribute('data-alarm'));
            });
        });

        // Request initial data
        setTimeout(() => {
            if (this.isConnected) {
                this.socket.emit('request_data');
            }
        }, 1000);
    }

    // Dev helper: force a reading past (or back within) its setpoint, then re-render + re-check.
    devTriggerAlarm(kind) {
        // Work off the last received data so setpoints/units stay consistent
        const d = this.data || {};
        d.skid = d.skid || {};
        d.tank = d.tank || {};
        const a = d.alarms || {};

        switch (kind) {
            case 'pressure_high':
                d.skid.skid_pressure = (a.pressure_high ?? 0) + 500;
                break;
            case 'flow_high':
                d.skid.skid_flow = (a.flow_high ?? 0) + 20;
                break;
            case 'flow_low':
                d.skid.skid_flow = Math.max(0, (a.flow_low ?? 0) - 5);
                break;
            case 'tank_low':
                d.tank.tank_level_mm = Math.max(0, (a.tank_level_low ?? 0) - 25.4);
                break;
            case 'clear':
                // Reset every monitored reading to a safe value derived from its setpoints
                if (a.pressure_high != null) d.skid.skid_pressure = a.pressure_high * 0.5;
                if (a.flow_high != null && a.flow_low != null) {
                    d.skid.skid_flow = (a.flow_high + a.flow_low) / 2;
                }
                if (a.tank_level_low != null) d.tank.tank_level_mm = a.tank_level_low + 500;
                break;
            default:
                return;
        }

        this.data = d;
        this.updateDashboard(d);
    }
    
    updateConnectionStatus(connected) {
        if (connected) {
            this.connectionStatus.innerHTML = '<i class="fas fa-circle"></i> Connected';
            this.connectionStatus.className = 'status-connected';
        } else {
            this.connectionStatus.innerHTML = '<i class="fas fa-circle"></i> Disconnected';
            this.connectionStatus.className = 'status-disconnected';
        }
    }

    setSelectedPump(pumpNumber, fromWebSocket = false) {
        if (pumpNumber === 1 || pumpNumber === 2 || pumpNumber === 3){
            this.selectedPump = pumpNumber;
            this.updatePumpSelection();
            console.log(`Selected pump set to: ${this.selectedPump}`);
            
            // Only emit WebSocket event if not called from WebSocket (to avoid loops)
            if (!fromWebSocket && this.isConnected) {
                this.socket.emit('pump_selection_changed', {
                    selected_pump: this.selectedPump,
                    timestamp: new Date().toISOString()
                });
            }
        } else {
            console.error('Invalid pump number. Must be 0, 1 or 2.');
        }
        return this.selectedPump;
    }

    updatePumpSelection() {
        // Single combined pump layout: no per-pump highlighting to apply.
    }
    
    updateDashboard(data) {
        // Update pump data
        if (data.pump) {
            this.updatePumpData(data.pump);
        }

        // Update pump 2 data (card only shows when a second pump app is configured)
        if (data.pump2) {
            this.updatePump2Data(data.pump2);
        }

        // Apply display units before rendering values that depend on them
        if (data.units) {
            this.updateUnits(data.units);
        }

        // Update tank data
        if (data.tank) {
            this.updateTankData(data.tank);
        }

        // Update skid data
        if (data.skid) {
            this.updateSkidData(data.skid);
        }
        
        // Update system data
        if (data.system) {
            this.updateSystemData(data.system);
        }

        // Update selected pump/valve state
        if (data.selector) {
            this.setSelectedPump(data.selector.state);
        }

        // Update faults
        if (data.faults) {
            this.updateFaults(data.faults);
        } else {
            this.updateFaults({});
        }

        // Update alarm setpoint readouts
        if (data.alarms) {
            this.updateAlarmLevels(data.alarms);
        }

        // Detect any live reading that has exceeded its alarm setpoint
        this.checkAlarms();
    }

    // Compare live readings against their alarm setpoints; show the popover for any breach.
    checkAlarms() {
        const d = this.data || {};
        const skid = d.skid || {};
        const tank = d.tank || {};
        const a = d.alarms || {};
        const messages = [];

        if (skid.skid_pressure != null && a.pressure_high != null && skid.skid_pressure > a.pressure_high) {
            messages.push(`High Pressure — ${skid.skid_pressure.toFixed(1)} psi (limit ${a.pressure_high.toFixed(1)} psi)`);
        }
        if (skid.skid_flow != null && a.flow_high != null && skid.skid_flow > a.flow_high) {
            messages.push(`High Flow — ${skid.skid_flow.toFixed(1)} GPD (limit ${a.flow_high.toFixed(1)} GPD)`);
        }
        if (skid.skid_flow != null && a.flow_low != null && skid.skid_flow < a.flow_low) {
            messages.push(`Low Flow — ${skid.skid_flow.toFixed(1)} GPD (limit ${a.flow_low.toFixed(1)} GPD)`);
        }
        if (tank.tank_level_mm != null && a.tank_level_low != null && tank.tank_level_mm < a.tank_level_low) {
            messages.push(`Low Tank Level — ${this.formatLength(tank.tank_level_mm)} (limit ${this.formatLength(a.tank_level_low)})`);
        }

        this.renderAlarmPopover(messages);
    }

    // Format a millimetre value in the active length unit (mm or inches)
    formatLength(mm) {
        if (this.lengthUnit === 'inch') {
            return `${(mm / 25.4).toFixed(1)}"`;
        }
        return `${Math.round(mm)} mm`;
    }

    renderAlarmPopover(messages) {
        if (!this.alarmPopover || !this.alarmMessageList) {
            return;
        }
        this.alarmMessageList.innerHTML = '';
        if (messages.length > 0) {
            messages.forEach((message) => {
                const item = document.createElement('li');
                item.textContent = message;
                this.alarmMessageList.appendChild(item);
            });
            this.alarmPopover.classList.remove('hidden');
            this.alarmDim?.classList.add('active');
        } else {
            this.alarmPopover.classList.add('hidden');
            this.alarmDim?.classList.remove('active');
        }
    }
    
    updatePumpData(pumpData) {
        // Update pump state
        if (pumpData.pump_state !== undefined) {
            this.updatePumpState(pumpData.pump_state);
        }
    }

    updatePump2Data(pump2Data) {
        // Show/hide the whole Pump 2 column based on whether a second pump is configured
        const enabled = pump2Data.enabled !== false;
        this.setPump2Visible(enabled);
        if (!enabled) {
            return;
        }

        // Update pump 2 state
        if (pump2Data.pump_state !== undefined) {
            const state = pump2Data.pump_state;
            this.pump2State.textContent = state;
            this.pump2State.className = `state-value ${state.toLowerCase()}`;
        }
    }

    setPump2Visible(visible) {
        if (!this.pump2Section) {
            return;
        }
        if (visible) {
            this.pump2Section.classList.remove('hidden');
            this.hmiGrid?.classList.add('with-pump2');
            if (this.pump1Heading) {
                this.pump1Heading.innerHTML = '<i class="fas fa-pump"></i> Pump 1';
            }
        } else {
            this.pump2Section.classList.add('hidden');
            this.hmiGrid?.classList.remove('with-pump2');
            if (this.pump1Heading) {
                this.pump1Heading.innerHTML = '<i class="fas fa-pump"></i> Pump';
            }
        }
    }

    updateAlarmLevels(alarms) {
        if (alarms.pressure_high !== undefined) {
            const v = alarms.pressure_high.toFixed(1);
            if (this.pressureHighAlarm) this.pressureHighAlarm.textContent = v;
            if (this.pump2PressureHighAlarm) this.pump2PressureHighAlarm.textContent = v;
        }
        if (alarms.flow_high !== undefined && this.flowHighAlarm) {
            this.flowHighAlarm.textContent = alarms.flow_high.toFixed(1);
        }
        if (alarms.flow_low !== undefined && this.flowLowAlarm) {
            this.flowLowAlarm.textContent = alarms.flow_low.toFixed(1);
        }
        // Tank low alarm stored in mm; rendered in whichever length unit is active
        if (alarms.tank_level_low !== undefined) {
            this.tankLevelLowAlarmRawMm = alarms.tank_level_low;
            this.renderTankLowAlarm();
        }
    }

    renderTankLowAlarm() {
        if (!this.tankLevelLowAlarm) {
            return;
        }
        if (this.lengthUnit === 'inch') {
            if (this.tankLevelLowAlarmUnit) this.tankLevelLowAlarmUnit.textContent = '"';
            this.tankLevelLowAlarm.textContent = (this.tankLevelLowAlarmRawMm / 25.4).toFixed(1);
        } else {
            if (this.tankLevelLowAlarmUnit) this.tankLevelLowAlarmUnit.textContent = 'mm';
            this.tankLevelLowAlarm.textContent = Math.round(this.tankLevelLowAlarmRawMm).toString();
        }
    }

    updateUnits(unitsData) {
        // Length unit toggles tank level between millimeters and inches
        if (unitsData.length !== undefined) {
            const unit = unitsData.length === 'inch' ? 'inch' : 'mm';
            if (unit !== this.lengthUnit) {
                this.lengthUnit = unit;
                // Re-render the tank reading and its low alarm in the new unit
                this.renderTankLevel();
                this.renderTankLowAlarm();
            }
        }
    }

    renderTankLevel() {
        if (this.lengthUnit === 'inch') {
            const inches = this.tankLevelRawMm / 25.4;
            this.tankLevelUnit.textContent = '"';
            this.animateValueChange(this.tankLevelMm, inches.toFixed(1));
        } else {
            this.tankLevelUnit.textContent = 'mm';
            this.animateValueChange(this.tankLevelMm, Math.round(this.tankLevelRawMm).toString());
        }
    }

    updateTankData(tankData) {
        // Update tank level (raw value is always in mm; displayed unit is configurable)
        if (tankData.tank_level_mm !== undefined) {
            this.tankLevelRawMm = tankData.tank_level_mm;
            this.renderTankLevel();
        }

        // Update tank level percentage
        if (tankData.tank_level_percent !== undefined) {
            const percentage = Math.round(tankData.tank_level_percent);
            this.animateValueChange(this.tankLevelPercent, percentage.toString());
            this.updateTankGauge(percentage);
        }
    }

    updateSkidData(skidData) {
        // Update skid flow
        if (skidData.skid_flow !== undefined) {
            this.animateValueChange(this.skidFlow, skidData.skid_flow.toFixed(1));
        }

        // Update skid pressure (shared across both pump columns)
        if (skidData.skid_pressure !== undefined) {
            this.animateValueChange(this.skidPressure, skidData.skid_pressure.toFixed(1));
            if (this.pump2Pressure) {
                this.animateValueChange(this.pump2Pressure, skidData.skid_pressure.toFixed(1));
            }
        }

        // Update total flow over lifetime of the skid
        if (skidData.total_flow !== undefined) {
            this.animateValueChange(this.skidTotalFlow, skidData.total_flow.toFixed(1));
        }
    }

    updateSystemData(systemData) {
        // Update system status
        if (systemData.status !== undefined) {
            this.updateSystemStatus(systemData.status);
        }
    }

    updatePumpState(state) {
        this.pumpState.textContent = state;
        // Normalize state to lowercase for CSS class matching
        const normalizedState = state.toLowerCase();
        this.pumpState.className = `state-value ${normalizedState}`;

        // Update active button
        const buttons = document.querySelectorAll('.state-btn');
        buttons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-state') === state) {
                btn.classList.add('active');
            }
        });
    }

    updateTankGauge(percentage) {
        const pct = Math.max(0, Math.min(100, percentage));
        // Vertical gauge fills bottom-to-top via height
        this.tankProgress.style.height = `${pct}%`;

        // Update color based on percentage
        this.tankProgress.className = 'tank-gauge-fill';
        if (percentage < 5) {
            this.tankProgress.classList.add('low');
        } else if (percentage < 25) {
            this.tankProgress.classList.add('medium');
        }
    }
    
    updateSystemStatus(status) {
        if (this.systemStatus) {
            this.systemStatus.textContent = status;
            this.systemStatus.className = `status-value ${status}`;
        }
    }

    updateFaults(faultData = {}) {
        if (!this.faultPopover || !this.faultMessageList) {
            return;
        }

        const messages = [];
        const instructions = [];
        
        if (faultData.hh_pressure) {
            messages.push('High High Pressure Tripped the Pumps!');
            instructions.push('Reduce system pressure to clear the alarm');
        }
        if (faultData.ll_tank_level) {
            messages.push('Low Low Tank Level Tripped the Pumps! - Fill Tank');
            instructions.push('Please refill the tank');
        }

        this.faultMessageList.innerHTML = '';

        if (messages.length > 0) {
            messages.forEach(message => {
                const item = document.createElement('li');
                item.textContent = message;
                this.faultMessageList.appendChild(item);
            });

            if (this.faultInstructions) {
                // Show combined instructions if multiple faults, or single instruction
                this.faultInstructions.textContent = instructions.join('. ') + '.';
            }

            this.faultPopover.classList.remove('hidden');
        } else {
            this.faultPopover.classList.add('hidden');
        }
    }
    
    animateValueChange(element, newValue) {
        if (element.textContent !== newValue) {
            element.classList.add('updating');
            element.textContent = newValue;
            setTimeout(() => {
                element.classList.remove('updating');
            }, 1000);
        }
    }
    
    updateLastUpdateTime(timestamp) {
        if (timestamp) {
            // Parse the timestamp - server sends UTC timestamps with timezone info
            const time = new Date(timestamp);
            // Check if date is valid
            if (isNaN(time.getTime())) {
                console.warn('Invalid timestamp received:', timestamp);
                return;
            }
            // Use toLocaleTimeString with explicit options to ensure consistent formatting
            // This converts UTC to local timezone for display
            this.lastUpdate.textContent = time.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
        } else {
            // Fallback to current time if no timestamp provided
            const time = new Date();
            this.lastUpdate.textContent = time.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
        }
    }
    
    changePumpState(state) {
        if (this.isConnected) {
            this.socket.emit('set_pump_state', { state: state });
            console.log(`Requesting pump state change to: ${state}`);
        } else {
            this.showError('Not connected to server');
        }
    }
    
    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            
            setTimeout(() => {
                if (!this.isConnected) {
                    this.socket.connect();
                }
            }, this.reconnectDelay * this.reconnectAttempts);
        } else {
            console.error('Max reconnection attempts reached');
            this.showConnectionError();
        }
    }
    
    hideLoadingOverlay() {
        setTimeout(() => {
            this.loadingOverlay.classList.add('hidden');
        }, 500);
    }
    
    showLoadingOverlay() {
        this.loadingOverlay.classList.remove('hidden');
    }
    
    showConnectionError() {
        // Remove any existing connection error first
        this.hideConnectionError();
        // Store reference to the new error element
        this.connectionErrorElement = this.showError('Unable to connect to dashboard server. Please check your connection.');
    }
    
    hideConnectionError() {
        if (this.connectionErrorElement && this.connectionErrorElement.parentNode) {
            this.connectionErrorElement.parentNode.removeChild(this.connectionErrorElement);
            this.connectionErrorElement = null;
        }
    }
    
    showError(message) {
        // Create a simple error notification
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #e74c3c;
            color: white;
            padding: 15px 20px;
            border-radius: 5px;
            z-index: 1001;
            max-width: 300px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            cursor: pointer;
        `;
        errorDiv.textContent = message;
        errorDiv.setAttribute('role', 'alert');
        errorDiv.setAttribute('aria-live', 'assertive');
        
        document.body.appendChild(errorDiv);
        errorDiv.addEventListener('click', () => {
            if (errorDiv.parentNode) {
                errorDiv.parentNode.removeChild(errorDiv);
            }
            // Clear reference if this was the connection error
            if (this.connectionErrorElement === errorDiv) {
                this.connectionErrorElement = null;
            }
        });
        
        return errorDiv;
    }
    
    // Public API methods
    requestData() {
        if (this.isConnected) {
            this.socket.emit('request_data');
        }
    }
    
    getData() {
        return this.data;
    }
    
    isConnectedToServer() {
        return this.isConnected;
    }
    
    showValveControlPopup() {
        if (!this.valveControlPopup) {
            return;
        }
        
        // Show the popup
        this.valveControlPopup.classList.remove('hidden');
        
        // Hide after 5 seconds
        setTimeout(() => {
            if (this.valveControlPopup) {
                this.valveControlPopup.classList.add('hidden');
            }
        }, 5000);
    }
}

// Initialize dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new Dashboard();
    
    // Add keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
            switch(e.key) {
                case 'r':
                    e.preventDefault();
                    window.dashboard.requestData();
                    break;
                case 'f5':
                    e.preventDefault();
                    window.location.reload();
                    break;
            }
        }
    });
    
    // Handle page visibility changes
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && window.dashboard.isConnectedToServer()) {
            window.dashboard.requestData();
        }
    });
});

// Handle page unload
window.addEventListener('beforeunload', () => {
    if (window.dashboard && window.dashboard.socket) {
        window.dashboard.socket.disconnect();
    }
});
