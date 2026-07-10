# Petronash HMI Dashboard

A real-time web dashboard for the local touchscreen panel on a Petronash SIA pump skid,
featuring two-pump control, solar monitoring, tank level and alarm popovers.

## Features

### Pump Control
- **Target Rate**: Set and monitor target flow rate (GPD)
- **Flow Rate**: Real-time flow rate monitoring (GPD)
- **Pump State**: Pump states (standby, auto, calibration), for pumps 1 and 2

### Solar Control
- **Battery Voltage**: Averaged across all configured solar controllers (V)
- **Battery Percentage**: Visual battery level with progress bar (%)
- **Panel Power / Remaining Ah**: Averaged and summed respectively

### Tank Control
- **Tank Level**: Monitor tank levels in inches or mm (see `display_units`) and percentage
- **System Status**: Overall system status indicator

### Alarms
- High-pressure and low-tank-level exceedance popovers, dimming the screen behind them

## Technical Details

### Architecture
- **Backend**: Flask web server with WebSocket support
- **Frontend**: HTML5, CSS3, JavaScript with Socket.IO client
- **Real-time Communication**: WebSocket connections for live data updates
- **Port**: 8091 (configurable)

### Components

1. **`dashboard.py`**: Core dashboard server and interface classes
   - `PetronashDashboard`: Main Flask server with WebSocket support
   - `DashboardInterface`: Integration interface for Application class
   - `DashboardData`: Data container with validation

2. **`templates/dashboard.html`**: Main dashboard UI template

3. **`static/css/dashboard.css`**: Modern, responsive styling

4. **`static/js/dashboard.js`**: Client-side JavaScript for real-time updates

## Usage

### Integration with Application
The dashboard is automatically integrated into the `SiaLocalControlUiApplication` class:

```python
# Dashboard starts automatically on port 8091
# Data is updated via the main application loop
```

### Manual Testing
Run the test script to verify dashboard functionality:

```bash
python test_dashboard.py
```

Then open your browser to: `http://127.0.0.1:8091`

### API Endpoints

- `GET /`: Main dashboard interface
- `GET /api/data`: REST API for current data (JSON)
- `GET /api/health`: Health check endpoint

### WebSocket Events

**Client to Server:**
- `request_data`: Request current data
- `set_pump_state`: Change pump state

**Server to Client:**
- `data_update`: Broadcast data updates
- `heartbeat`: Periodic connection heartbeat
- `error`: Error notifications

## Dependencies

- Flask >= 3.0.0
- Flask-SocketIO >= 5.3.0 (pulls in python-socketio)

## Configuration

The dashboard is constructed in the Application's `setup()`:

```python
# In application.py
self.dashboard = PetronashDashboard(
    host="0.0.0.0",  # Bind to all interfaces
    port=8091,       # Dashboard port
    debug=False      # Debug mode
)
```

## Browser Compatibility

- Modern browsers with WebSocket support
- Chrome 16+, Firefox 11+, Safari 7+, Edge 12+
- Mobile responsive design

## Security Notes

- Dashboard binds to all interfaces (0.0.0.0) for accessibility
- No authentication implemented (add as needed for production)
- CORS enabled for development
- Consider adding HTTPS in production environments

## Troubleshooting

1. **Port already in use**: Change port in dashboard configuration
2. **WebSocket connection failed**: Check firewall settings
3. **No data updates**: Verify Application class integration
4. **Styling issues**: Clear browser cache

## Future Enhancements

- User authentication and authorization
- Historical data logging and charts
- Alert/notification system
- Mobile app support
- Multi-language support
- Customizable dashboard layouts
