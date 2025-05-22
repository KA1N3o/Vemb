const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
let db;
async function setupDatabase() {
    db = await open({
        filename: path.join(__dirname, 'database.sqlite'),
        driver: sqlite3.Database
    });

    // Create flights table if it doesn't exist
    await db.exec(`
        CREATE TABLE IF NOT EXISTS flights (
            flight_id INTEGER PRIMARY KEY AUTOINCREMENT,
            airline TEXT NOT NULL,
            airline_code TEXT NOT NULL,
            flight_number TEXT NOT NULL,
            departure_airport TEXT NOT NULL,
            arrival_airport TEXT NOT NULL,
            departure_time DATETIME NOT NULL,
            arrival_time DATETIME NOT NULL,
            duration TEXT NOT NULL,
            price_economy REAL NOT NULL,
            price_premium_economy REAL,
            price_business REAL,
            price_first REAL,
            seats_economy INTEGER NOT NULL,
            seats_premium_economy INTEGER,
            seats_business INTEGER,
            seats_first INTEGER,
            available_seats INTEGER NOT NULL,  -- Total count (kept for backward compatibility)
            status TEXT DEFAULT 'scheduled',
            available_classes TEXT NOT NULL
        );

        -- Bảng BOOKINGS with round-trip support
        CREATE TABLE IF NOT EXISTS bookings (
            booking_id TEXT PRIMARY KEY,
            departure_flight_id INTEGER NOT NULL,
            return_flight_id INTEGER,               -- Null for one-way trips
            contact_name TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            travel_class TEXT NOT NULL,             -- Hạng vé được chọn (economy/business)
            total_amount REAL NOT NULL,
            booking_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            payment_status TEXT DEFAULT 'unpaid',
            promo_code TEXT,                        -- Mã khuyến mãi nếu có
            passengers_info TEXT,                   -- Additional passenger information
            is_round_trip BOOLEAN DEFAULT 0,        -- Flag to indicate if this is a round-trip booking
            FOREIGN KEY (departure_flight_id) REFERENCES flights(flight_id),
            FOREIGN KEY (return_flight_id) REFERENCES flights(flight_id)
        );

        -- Bảng BOOKING_DETAILS
        CREATE TABLE IF NOT EXISTS booking_details (            
            detail_id INTEGER PRIMARY KEY AUTOINCREMENT,            
            booking_id TEXT NOT NULL,            
            full_name TEXT NOT NULL,            
            gender TEXT,            
            dob TEXT,            
            passport_number TEXT NOT NULL,            
            passenger_type TEXT DEFAULT 'ADULT',    -- Loại hành khách: ADULT, CHILD, INFANT            
            luggage_weight REAL DEFAULT 0,          -- Số kg hành lý ký gửi (nếu có)            
            insurance BOOLEAN DEFAULT 0,            -- Có mua bảo hiểm không            
            meal BOOLEAN DEFAULT 0,                 -- Có suất ăn đặc biệt không            
            FOREIGN KEY (booking_id) REFERENCES bookings(booking_id)        
        );

        -- Bảng PAYMENTS
        CREATE TABLE IF NOT EXISTS payments (
            booking_id TEXT PRIMARY KEY,
            method TEXT NOT NULL CHECK (method IN ('bank_transfer', 'momo')),
            transaction_info TEXT, -- Tùy chọn: có thể là tên người chuyển khoản hoặc số điện thoại MoMo
            payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(booking_id)
        );

        -- Bảng PROMOTIONS
        CREATE TABLE IF NOT EXISTS promotions (
            promo_id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,              -- Mã khuyến mãi (VD: SUMMER25)
            name TEXT NOT NULL,                     -- Tên khuyến mãi
            description TEXT,
            discount_type TEXT CHECK(discount_type IN ('percent', 'fixed')) NOT NULL,
            discount_value REAL NOT NULL,
            valid_from TEXT,
            valid_to TEXT,
            usage_limit INTEGER,
            used_count INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'scheduled', 'expired'))
        );
    `);

    // Check if we have flights in the database
    const count = await db.get('SELECT COUNT(*) as count FROM flights');
    if (count.count === 0) {
        console.log('Populating database with sample flights...');
        await populateSampleFlights();
    }

    // Check if we have any promotions in the database
    const promoCount = await db.get('SELECT COUNT(*) as count FROM promotions');
    if (promoCount.count === 0) {
        console.log('Adding sample promotions...');
        await populateSamplePromotions();
    }
}

// API endpoints
app.get('/api/flights', async (req, res) => {
    try {
        const { departure, destination, departDate, seatClass, status } = req.query;
        
        let query = 'SELECT * FROM flights WHERE 1=1';
        const params = [];

        if (departure) {
            query += ' AND departure_airport = ?';
            params.push(departure);
        }

        if (destination) {
            query += ' AND arrival_airport = ?';
            params.push(destination);
        }

        if (departDate) {
            // Convert YYYY-MM-DD to date format in the database
            const formattedDate = formatDateForDB(departDate);
            query += ' AND DATE(departure_time) = ?';
            params.push(formattedDate);
        }

        if (seatClass) {
            query += ' AND available_classes LIKE ?';
            params.push(`%${seatClass}%`);
        }
        
        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }

        const flights = await db.all(query, params);
        
        // Format flights for client
        const formattedFlights = flights.map(formatFlightForClient);
        
        res.json(formattedFlights);
    } catch (error) {
        console.error('Error fetching flights:', error);
        res.status(500).json({ error: 'Failed to fetch flights' });
    }
});

app.get('/api/flights/:id', async (req, res) => {
    try {
        const flight = await db.get('SELECT * FROM flights WHERE flight_id = ?', req.params.id);
        
        if (!flight) {
            return res.status(404).json({ error: 'Flight not found' });
        }
        
        res.json(formatFlightForClient(flight));
    } catch (error) {
        console.error('Error fetching flight:', error);
        res.status(500).json({ error: 'Failed to fetch flight details' });
    }
});

// Admin API: Create a new flight
app.post('/api/flights', async (req, res) => {
    try {
        const { 
            airline, airline_code, flight_number, 
            departure_airport, arrival_airport, 
            departure_time, arrival_time, 
            price_economy, price_premium_economy, price_business, price_first,
            seats_economy, seats_premium_economy, seats_business, seats_first,
            status, available_classes 
        } = req.body;

        // Validate required fields
        if (!airline || !airline_code || !flight_number || 
            !departure_airport || !arrival_airport || 
            !departure_time || !arrival_time || 
            !price_economy || !seats_economy || !available_classes) {
            return res.status(400).json({ error: 'Missing required flight information' });
        }

        // Calculate duration
        const deptTime = new Date(departure_time);
        const arrTime = new Date(arrival_time);
        const durationMs = arrTime - deptTime;
        const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
        const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
        const duration = `${durationHours}h ${durationMinutes}m`;

        // Calculate total available seats
        const total_seats = (seats_economy || 0) + 
                           (seats_premium_economy || 0) + 
                           (seats_business || 0) + 
                           (seats_first || 0);

        // available_classes có thể là mảng hoặc chuỗi, đảm bảo lưu là chuỗi
        const availableClassesString = Array.isArray(available_classes) 
            ? available_classes.join(',') 
            : available_classes;

        // Insert new flight
        const result = await db.run(`
            INSERT INTO flights (
                airline, airline_code, flight_number, departure_airport, arrival_airport, 
                departure_time, arrival_time, duration,
                price_economy, price_premium_economy, price_business, price_first,
                seats_economy, seats_premium_economy, seats_business, seats_first,
                available_seats, status, available_classes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            airline, airline_code, flight_number, departure_airport, arrival_airport, 
            departure_time, arrival_time, duration,
            price_economy, price_premium_economy, price_business, price_first,
            seats_economy, seats_premium_economy, seats_business, seats_first,
            total_seats, status || 'scheduled', availableClassesString
        ]);

        const newFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', [result.lastID]);
        res.status(201).json(formatFlightForClient(newFlight));
    } catch (error) {
        console.error('Error creating flight:', error);
        res.status(500).json({ error: 'Failed to create flight', details: error.message });
    }
});

// Admin API: Update a flight
app.put('/api/flights/:id', async (req, res) => {
    try {
        const flightId = req.params.id;
        const { 
            airline, airline_code, flight_number, 
            departure_airport, arrival_airport, 
            departure_time, arrival_time, 
            price_economy, price_premium_economy, price_business, price_first,
            seats_economy, seats_premium_economy, seats_business, seats_first,
            available_seats, status, 
            available_classes 
        } = req.body;

        // Validate required fields
        if (!airline || !airline_code || !flight_number || 
            !departure_airport || !arrival_airport || 
            !departure_time || !arrival_time || 
            !price_economy || !available_seats || !available_classes) {
            return res.status(400).json({ error: 'Missing required flight information' });
        }

        // Check if flight exists
        const existingFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', flightId);
        if (!existingFlight) {
            return res.status(404).json({ error: 'Flight not found' });
        }

        // Calculate duration
        const deptTime = new Date(departure_time);
        const arrTime = new Date(arrival_time);
        const durationMs = arrTime - deptTime;
        const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
        const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
        const duration = `${durationHours}h ${durationMinutes}m`;

        // available_classes có thể là mảng hoặc chuỗi, đảm bảo lưu là chuỗi
        const availableClassesString = Array.isArray(available_classes) 
            ? available_classes.join(',') 
            : available_classes;

        console.log('Updating flight with ID:', flightId);
        console.log('Data received:', req.body);

        // Update the flight
        await db.run(`
            UPDATE flights SET
                airline = ?, airline_code = ?, flight_number = ?,
                departure_airport = ?, arrival_airport = ?,
                departure_time = ?, arrival_time = ?, duration = ?,
                price_economy = ?, price_premium_economy = ?, price_business = ?, price_first = ?,
                seats_economy = ?, seats_premium_economy = ?, seats_business = ?, seats_first = ?,
                available_seats = ?, status = ?, available_classes = ?
            WHERE flight_id = ?
        `, [
            airline, airline_code, flight_number,
            departure_airport, arrival_airport,
            departure_time, arrival_time, duration,
            price_economy, price_premium_economy || null, price_business || null, price_first || null,
            seats_economy || 0, seats_premium_economy || 0, seats_business || 0, seats_first || 0,
            available_seats, status, availableClassesString,
            flightId
        ]);

        // Get the updated flight
        const updatedFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', flightId);
        
        console.log('Updated flight:', updatedFlight);
        res.json(formatFlightForClient(updatedFlight));
    } catch (error) {
        console.error('Error updating flight:', error);
        res.status(500).json({ error: 'Failed to update flight', details: error.message });
    }
});

// Admin API: Update a flight by flight code
app.put('/api/flights/code/:flightCode', async (req, res) => {
    try {
        const flightCode = req.params.flightCode;
        const { 
            airline, airline_code, flight_number, 
            departure_airport, arrival_airport, 
            departure_time, arrival_time, 
            price_economy, price_premium_economy, price_business, price_first,
            seats_economy, seats_premium_economy, seats_business, seats_first,
            status, available_classes 
        } = req.body;

        // Validate required fields
        if (!airline || !airline_code || !flight_number || 
            !departure_airport || !arrival_airport || 
            !departure_time || !arrival_time || 
            !price_economy || !seats_economy || !available_classes) {
            return res.status(400).json({ error: 'Missing required flight information' });
        }

        // Calculate duration
        const deptTime = new Date(departure_time);
        const arrTime = new Date(arrival_time);
        const durationMs = arrTime - deptTime;
        const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
        const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
        const duration = `${durationHours}h ${durationMinutes}m`;

        // Calculate total available seats
        const total_seats = (seats_economy || 0) + 
                           (seats_premium_economy || 0) + 
                           (seats_business || 0) + 
                           (seats_first || 0);

        // Ensure available_classes is in the right format
        const availableClassesString = Array.isArray(available_classes) 
            ? available_classes.join(',') 
            : available_classes;

        // Find the flight by code
        const existingFlight = await db.get(
            'SELECT * FROM flights WHERE airline_code || flight_number = ?', 
            [flightCode]
        );

        if (!existingFlight) {
            return res.status(404).json({ error: 'Flight not found' });
        }

        // Update the flight
        await db.run(`
            UPDATE flights SET
                airline = ?, airline_code = ?, flight_number = ?,
                departure_airport = ?, arrival_airport = ?,
                departure_time = ?, arrival_time = ?, duration = ?,
                price_economy = ?, price_premium_economy = ?, price_business = ?, price_first = ?,
                seats_economy = ?, seats_premium_economy = ?, seats_business = ?, seats_first = ?,
                available_seats = ?, status = ?, available_classes = ?
            WHERE flight_id = ?
        `, [
            airline, airline_code, flight_number,
            departure_airport, arrival_airport,
            departure_time, arrival_time, duration,
            price_economy, price_premium_economy, price_business, price_first,
            seats_economy, seats_premium_economy, seats_business, seats_first,
            total_seats, status, availableClassesString,
            existingFlight.flight_id
        ]);

        const updatedFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', [existingFlight.flight_id]);
        res.json(formatFlightForClient(updatedFlight));
    } catch (error) {
        console.error('Error updating flight:', error);
        res.status(500).json({ error: 'Failed to update flight', details: error.message });
    }
});

// Admin API: Delete a flight
app.delete('/api/flights/:id', async (req, res) => {
    try {
        const flightId = req.params.id;

        // Check if flight exists
        const existingFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', flightId);
        if (!existingFlight) {
            return res.status(404).json({ error: 'Flight not found' });
        }

        // Check if flight has bookings
        const bookings = await db.get('SELECT COUNT(*) as count FROM bookings WHERE flight_id = ?', flightId);
        if (bookings.count > 0) {
            return res.status(400).json({ 
                error: 'Cannot delete flight with existing bookings',
                bookingsCount: bookings.count
            });
        }

        // Delete the flight
        await db.run('DELETE FROM flights WHERE flight_id = ?', flightId);
        
        res.json({ message: 'Flight deleted successfully' });
    } catch (error) {
        console.error('Error deleting flight:', error);
        res.status(500).json({ error: 'Failed to delete flight' });
    }
});

// Admin API: Delete a flight by code
app.delete('/api/flights/code/:flightCode', async (req, res) => {
    try {
        const flightCode = req.params.flightCode;
        
        // Extract airline code and flight number from flightCode
        let airlineCode = '';
        let flightNum = '';
        
        // Common format is 2 letters followed by numbers (e.g., VN1000)
        const match = flightCode.match(/^([A-Z]+)(\d+)$/);
        if (match) {
            airlineCode = match[1];
            flightNum = match[2];
        } else {
            // Fallback to the whole code
            airlineCode = flightCode;
        }

        // Check if flight exists
        const existingFlight = await db.get('SELECT * FROM flights WHERE airline_code = ? AND flight_number = ?', [airlineCode, flightNum]);
        if (!existingFlight) {
            return res.status(404).json({ error: 'Flight not found' });
        }

        // Check if flight has bookings
        const bookings = await db.get('SELECT COUNT(*) as count FROM bookings WHERE flight_id = ?', existingFlight.flight_id);
        if (bookings.count > 0) {
            return res.status(400).json({ 
                error: 'Cannot delete flight with existing bookings',
                bookingsCount: bookings.count
            });
        }

        // Delete the flight
        await db.run('DELETE FROM flights WHERE flight_id = ?', existingFlight.flight_id);
        
        res.json({ message: 'Flight deleted successfully' });
    } catch (error) {
        console.error('Error deleting flight:', error);
        res.status(500).json({ error: 'Failed to delete flight', details: error.message });
    }
});

// Admin API: Flight statistics
app.get('/api/admin/stats/flights', async (req, res) => {
    try {
        // Get flight count by status
        const statusStats = await db.all(`
            SELECT status, COUNT(*) as count 
            FROM flights 
            GROUP BY status 
            ORDER BY count DESC
        `);
        
        // Get total bookings count
        const totalBookings = await db.get(`
            SELECT COUNT(*) as count 
            FROM bookings
        `);
        
        // Get upcoming flights count (next 24 hours)
        const upcomingFlights = await db.get(`
            SELECT COUNT(*) as count 
            FROM flights 
            WHERE departure_time BETWEEN datetime('now') AND datetime('now', '+24 hours')
            AND status IN ('scheduled', 'boarding')
        `);
        
        // Get most popular routes
        const popularRoutes = await db.all(`
            SELECT departure_airport, arrival_airport, COUNT(*) as count 
            FROM flights
            GROUP BY departure_airport, arrival_airport
            ORDER BY count DESC
            LIMIT 5
        `);
        
        // Get bookings by travel class
        const bookingsByClass = await db.all(`
            SELECT travel_class, COUNT(*) as count 
            FROM bookings 
            GROUP BY travel_class
        `);
        
        res.json({
            flightsByStatus: statusStats,
            totalBookings: totalBookings.count,
            upcomingFlights: upcomingFlights.count,
            popularRoutes,
            bookingsByClass
        });
    } catch (error) {
        console.error('Error fetching flight statistics:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// Additional API endpoints for booking
app.post('/api/bookings', async (req, res) => {
    try {
        // Support both naming conventions
        const { 
            departureFlightId, 
            departure_flight_id,
            returnFlightId,
            return_flight_id,
            isRoundTrip,
            is_round_trip,
            customerInfo, 
            passengers, 
            selectedServices, 
            promoCode, 
            totalAmount, 
            passengerCounts, 
            paymentMethod, 
            transactionInfo 
        } = req.body;

        // Use the data regardless of which field name was used
        const finalDepartureFlightId = departureFlightId || departure_flight_id;
        const finalReturnFlightId = returnFlightId || return_flight_id;
        const finalIsRoundTrip = isRoundTrip || is_round_trip;
        
        // Log the request for debugging
        console.log('Booking Request:', { 
            departureFlightId: finalDepartureFlightId, 
            returnFlightId: finalReturnFlightId, 
            isRoundTrip: finalIsRoundTrip,
            customerInfo, 
            passengersCount: passengers?.length 
        });
        
        // Validate required fields with better error messages
        const missingFields = [];
        if (!finalDepartureFlightId) missingFields.push('departureFlightId');
        if (!customerInfo) missingFields.push('customerInfo');
        if (!passengers || passengers.length === 0) missingFields.push('passengers');
        
        if (missingFields.length > 0) {
            console.error('Missing required booking information:', missingFields);
            return res.status(400).json({ 
                error: 'Missing required booking information', 
                missingFields: missingFields,
                receivedData: {
                    hasDepartureFlightId: !!finalDepartureFlightId,
                    hasCustomerInfo: !!customerInfo,
                    passengersCount: passengers?.length || 0
                }
            });
        }
        
        // Get departure flight details - check by both ID and flight number
        let departureFlight = null;
        // Try to find by flight_id (database id) first
        if (!isNaN(finalDepartureFlightId)) {
            departureFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', [finalDepartureFlightId]);
        }
        
        // If not found, try by airline_code + flight_number (display id)
        if (!departureFlight) {
            departureFlight = await db.get('SELECT * FROM flights WHERE (airline_code || flight_number) = ?', [finalDepartureFlightId]);
        }
        
        if (!departureFlight) {
            return res.status(404).json({ 
                error: 'Departure flight not found', 
                providedId: finalDepartureFlightId,
                lookupType: isNaN(finalDepartureFlightId) ? 'display_id' : 'database_id'
            });
        }

        // Get return flight details if this is a round trip
        let returnFlight = null;
        
        if (finalIsRoundTrip && finalReturnFlightId) {
            // Try to find by flight_id (database id) first
            if (!isNaN(finalReturnFlightId)) {
                returnFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', [finalReturnFlightId]);
            }
            
            // If not found, try by airline_code + flight_number (display id)
            if (!returnFlight) {
                returnFlight = await db.get('SELECT * FROM flights WHERE (airline_code || flight_number) = ?', [finalReturnFlightId]);
            }
            
            if (!returnFlight) {
                return res.status(404).json({ 
                    error: 'Return flight not found',
                    providedId: finalReturnFlightId,
                    lookupType: isNaN(finalReturnFlightId) ? 'display_id' : 'database_id'
                });
            }
        }

        // Check if enough seats are available for departure flight based on seat class
        const totalPassengers = passengers.length;
        const seatClass = customerInfo.seatClass || 'ECONOMY';

        // Determine which seat field to check based on the seat class
        let seatField, seatValue;
        switch(seatClass) {
            case 'PREMIUM_ECONOMY':
                seatField = 'seats_premium_economy';
                break;
            case 'BUSINESS':
                seatField = 'seats_business';
                break;
            case 'FIRST':
                seatField = 'seats_first';
                break;
            case 'ECONOMY':
            default:
                seatField = 'seats_economy';
                break;
        }
        
        // Make sure to get the correct seat value from the departureFlight
        seatValue = departureFlight[seatField];
        
        console.log(`Checking seats for class ${seatClass}, field: ${seatField}, available: ${seatValue}, needed: ${totalPassengers}`);

        // Check if the selected class has enough seats
        if (seatValue < totalPassengers) {
            return res.status(400).json({ 
                error: `Not enough ${seatClass.toLowerCase()} seats available on departure flight`, 
                available: seatValue,
                requested: totalPassengers,
                seatClass: seatClass
            });
        }

        // Check if enough seats are available for return flight if this is a round trip
        if (finalIsRoundTrip && returnFlight) {
            let returnSeatValue;
            switch(seatClass) {
                case 'PREMIUM_ECONOMY':
                    returnSeatValue = returnFlight.seats_premium_economy;
                    break;
                case 'BUSINESS':
                    returnSeatValue = returnFlight.seats_business;
                    break;
                case 'FIRST':
                    returnSeatValue = returnFlight.seats_first;
                    break;
                case 'ECONOMY':
                default:
                    returnSeatValue = returnFlight.seats_economy;
                    break;
            }
            
            if (returnSeatValue < totalPassengers) {
                return res.status(400).json({ 
                    error: `Not enough ${seatClass.toLowerCase()} seats available on return flight`, 
                    available: returnSeatValue,
                    requested: totalPassengers,
                    seatClass: seatClass
                });
            }
        }

        // Calculate total amount based on provided total or calculate it
        let finalAmount;
        
        if (totalAmount !== undefined && totalAmount !== null) {
            // Use the provided total amount directly
            finalAmount = totalAmount;
            console.log("Tạo hóa đơn thành công với số tiền:", finalAmount);
        } else {
            // Calculate if not provided - this is a fallback
            console.log("No total amount provided, calculating based on seat prices");
            
            const seatClass = customerInfo.seatClass || 'ECONOMY';
            
            // Get the price for the selected seat class directly from the flight data
            let basePrice;
            
            // Select the appropriate price based on seat class
            switch(seatClass) {
                case 'PREMIUM_ECONOMY':
                    basePrice = departureFlight.price_premium_economy || departureFlight.price_economy;
                    break;
                case 'BUSINESS':
                    basePrice = departureFlight.price_business || departureFlight.price_economy;
                    break;
                case 'FIRST':
                    basePrice = departureFlight.price_first || departureFlight.price_economy;
                    break;
                case 'ECONOMY':
                default:
                    basePrice = departureFlight.price_economy;
                    break;
            }
            
            // Tính tổng giá dựa trên loại hành khách
            let calculatedAmount = 0;
            for (const passenger of passengers) {
                // Xác định loại hành khách dựa trên dữ liệu từ client hoặc tự suy luận từ ngày sinh
                const passengerType = passenger.passengerType || 
                                   passenger.type || 
                                   determinePassengerTypeFromDOB(passenger.dob) || 
                                   'ADULT';
                
                const passengerTypeMultiplier = getPriceMultiplierForPassengerType(passengerType.toUpperCase());
                
                // Tính giá vé cho hành khách này
                const passengerPrice = basePrice * passengerTypeMultiplier;
                calculatedAmount += passengerPrice;
                
                // Gán loại hành khách vào object hành khách
                passenger.calculatedPassengerType = passengerType.toUpperCase();
            }
            
            // If this is a round trip booking, add the return flight price
            if (finalIsRoundTrip && returnFlight) {
                // Get the price for the selected seat class from the return flight
                let returnBasePrice;
                
                // Select the appropriate price based on seat class
                switch(seatClass) {
                    case 'PREMIUM_ECONOMY':
                        returnBasePrice = returnFlight.price_premium_economy || returnFlight.price_economy;
                        break;
                    case 'BUSINESS':
                        returnBasePrice = returnFlight.price_business || returnFlight.price_economy;
                        break;
                    case 'FIRST':
                        returnBasePrice = returnFlight.price_first || returnFlight.price_economy;
                        break;
                    case 'ECONOMY':
                    default:
                        returnBasePrice = returnFlight.price_economy;
                        break;
                }
                
                // Calculate return flight cost for all passengers
                for (const passenger of passengers) {
                    const passengerType = passenger.calculatedPassengerType || 'ADULT';
                    const passengerTypeMultiplier = getPriceMultiplierForPassengerType(passengerType);
                    const passengerReturnPrice = returnBasePrice * passengerTypeMultiplier;
                    calculatedAmount += passengerReturnPrice;
                }
            }
        
        // Apply promo code if provided
            finalAmount = calculatedAmount;
        
        if (promoCode) {
            const promo = await db.get('SELECT * FROM promotions WHERE code = ? AND used_count < usage_limit AND valid_from <= date("now") AND valid_to >= date("now")', [promoCode]);
            
            if (promo) {
                    let discountApplied = 0;
                if (promo.discount_type === 'percent') {
                        discountApplied = calculatedAmount * (promo.discount_value / 100);
                } else if (promo.discount_type === 'fixed') {
                    discountApplied = promo.discount_value;
                }
                    finalAmount = calculatedAmount - discountApplied;
                
                // Update promo used count
                await db.run('UPDATE promotions SET used_count = used_count + 1 WHERE promo_id = ?', [promo.promo_id]);
                    console.log(`Promo code ${promoCode} used. Count incremented to ${promo.used_count + 1}.`);
                } else {
                    console.log(`Invalid or expired promo code: ${promoCode}`);
                }
            }
            
            console.log("Calculated total amount:", finalAmount);
        }
        
        // Ensure finalAmount is never negative
        finalAmount = Math.max(0, finalAmount);
        
        // Serialize passenger counts for storage
        const passengerCountsJSON = JSON.stringify(passengerCounts || {
            numAdults: passengers.filter(p => (p.type === 'adult' || p.passengerType === 'ADULT')).length,
            numChildren: passengers.filter(p => (p.type === 'child' || p.passengerType === 'CHILD')).length,
            numInfants: passengers.filter(p => (p.type === 'infant' || p.passengerType === 'INFANT')).length
        });
        
        // Generate a unique booking ID
        let bookingId;
        let isUnique = false;
        
        while (!isUnique) {
            bookingId = generateBookingId();
            // Check if this ID already exists
            const existingBooking = await db.get('SELECT booking_id FROM bookings WHERE booking_id = ?', [bookingId]);
            if (!existingBooking) {
                isUnique = true;
            }
        }
        
        // Update available seats in the flights table for departure flight
        console.log(`Updating seats for departure flight ${departureFlight.flight_id}, reducing ${seatField} by ${totalPassengers}`);
        await db.run(`UPDATE flights SET 
            ${seatField} = ${seatField} - ?, 
            available_seats = available_seats - ? 
            WHERE flight_id = ?`, 
            [totalPassengers, totalPassengers, departureFlight.flight_id]
        );
        
        // Log the updated flight info for verification
        const updatedDepartureFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', [departureFlight.flight_id]);
        console.log('Updated departure flight seats:', {
            flight_id: updatedDepartureFlight.flight_id,
            [seatField]: updatedDepartureFlight[seatField],
            available_seats: updatedDepartureFlight.available_seats
        });
        
        // Update available seats for return flight if this is a round trip booking
        if (finalIsRoundTrip && returnFlight) {
            let returnSeatField;
            switch(seatClass) {
                case 'PREMIUM_ECONOMY':
                    returnSeatField = 'seats_premium_economy';
                    break;
                case 'BUSINESS':
                    returnSeatField = 'seats_business';
                    break;
                case 'FIRST':
                    returnSeatField = 'seats_first';
                    break;
                case 'ECONOMY':
                default:
                    returnSeatField = 'seats_economy';
                    break;
            }
            
            console.log(`Updating seats for return flight ${returnFlight.flight_id}, reducing ${returnSeatField} by ${totalPassengers}`);
            await db.run(`UPDATE flights SET 
                ${returnSeatField} = ${returnSeatField} - ?, 
                available_seats = available_seats - ? 
                WHERE flight_id = ?`, 
                [totalPassengers, totalPassengers, returnFlight.flight_id]
            );
            
            // Log the updated return flight info for verification
            const updatedReturnFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', [returnFlight.flight_id]);
            console.log('Updated return flight seats:', {
                flight_id: updatedReturnFlight.flight_id,
                [returnSeatField]: updatedReturnFlight[returnSeatField],
                available_seats: updatedReturnFlight.available_seats
            });
        }
        
        // Insert booking record with passenger counts
        await db.run(`
            INSERT INTO bookings (
                booking_id, departure_flight_id, return_flight_id, contact_name, email, phone, travel_class, 
                total_amount, booking_time, payment_status, promo_code, passengers_info, is_round_trip
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            bookingId,
            departureFlight.flight_id,
            finalIsRoundTrip ? returnFlight.flight_id : null,
            customerInfo.fullName,
            customerInfo.email,
            customerInfo.phone,
            customerInfo.seatClass || 'ECONOMY',
            finalAmount,
            new Date().toISOString(), // Explicitly set the current time with timezone info
            'unpaid',
            promoCode || null,
            passengerCountsJSON,
            finalIsRoundTrip ? 1 : 0
        ]);
        
        // Check and sanitize passenger data
        for (const passenger of passengers) {
            // Check if required passenger properties exist
            if (!passenger.fullName) {
                return res.status(400).json({
                    error: 'Passenger data missing required fields',
                    details: 'fullName is required for all passengers'
                });
            }
            
            // Make sure we have a valid passport number or ID
            const passportNumber = passenger.idNumber || passenger.passport_number || passenger.passportNumber || 'UNKNOWN_ID';
            
            // Xác định loại hành khách - ưu tiên dữ liệu từ client hơn
            let passengerType;
            
            if (passenger.type) {
                // Nếu có dữ liệu type từ client, sử dụng và chuyển thành định dạng chuẩn
                if (passenger.type.toLowerCase() === 'adult') passengerType = 'ADULT';
                else if (passenger.type.toLowerCase() === 'child') passengerType = 'CHILD';
                else if (passenger.type.toLowerCase() === 'infant') passengerType = 'INFANT';
                else passengerType = 'ADULT'; // Mặc định là người lớn
            } else if (passenger.passengerType) {
                // Nếu có dữ liệu passengerType từ client
                passengerType = passenger.passengerType.toUpperCase();
            } else if (passenger.calculatedPassengerType) {
                // Nếu đã tính toán trước đó trong API
                passengerType = passenger.calculatedPassengerType;
            } else {
                // Nếu không có, xác định từ ngày sinh
                passengerType = determinePassengerTypeFromDOB(passenger.dob) || 'ADULT';
            }
            
            try {
            await db.run(`
                INSERT INTO booking_details (
                    booking_id, full_name, gender, dob, passport_number,
                        passenger_type, luggage_weight, insurance, meal
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                bookingId,
                passenger.fullName,
                    passenger.gender || 'UNKNOWN',
                    passenger.dob || null,
                    passportNumber,
                    passengerType,
                selectedServices && selectedServices.luggage ? 23 : 0,  // 23kg if luggage selected
                    selectedServices && selectedServices.insurance ? 1 : 0,  // 1 if insurance selected
                    selectedServices && (selectedServices.meal || selectedServices.food) ? 1 : 0  // 1 if meal selected
            ]);
            } catch (insertError) {
                console.error('Error inserting passenger booking details:', insertError);
                // Attempt to rollback by deleting the booking
                await db.run('DELETE FROM bookings WHERE booking_id = ?', [bookingId]);
                throw new Error(`Failed to save passenger details: ${insertError.message}`);
            }
        }
        
        // Insert payment information if provided
        if (paymentMethod) {
            // Validate payment method
            if (paymentMethod !== 'bank_transfer' && paymentMethod !== 'momo') {
                console.warn(`Invalid payment method: ${paymentMethod}. Defaulting to momo.`);
                paymentMethod = 'momo';
            }
            
            await db.run(`
                INSERT INTO payments (
                    booking_id, method, transaction_info
                ) VALUES (?, ?, ?)
            `, [
                bookingId,
                paymentMethod,
                transactionInfo || null
            ]);
        }
        
        res.status(201).json({ 
            success: true, 
            bookingId,
            redirectUrl: `payment-waiting.html?booking_id=${bookingId}`,
            message: 'Booking created successfully',
            flightDetails: formatFlightForClient(departureFlight),
            totalAmount: finalAmount
        });
    } catch (error) {
        console.error('Error creating booking:', error);
        console.error('Error stack:', error.stack);
        console.error('Request data:', req.body);
        
        // Check if it's an SQLite constraint error
        if (error.code && error.code.includes('SQLITE_CONSTRAINT')) {
            return res.status(500).json({ 
                error: 'Failed to create booking due to database constraint', 
                details: error.message,
                constraint: error.code 
            });
        }
        
        res.status(500).json({ error: 'Failed to create booking', details: error.message });
    }
});

app.get('/api/bookings/:id', async (req, res) => {
    try {
        const bookingId = req.params.id;
        
        // Get booking details
        const booking = await db.get('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        
        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        // Get departure flight details
        const departureFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', [booking.departure_flight_id]);
        
        if (!departureFlight) {
            return res.status(404).json({ error: 'Departure flight not found for this booking' });
        }
        
        // Get return flight details if this is a round trip
        let returnFlight = null;
        if (booking.is_round_trip === 1 && booking.return_flight_id) {
            returnFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', [booking.return_flight_id]);
        }
        
        // Get passengers
        const passengers = await db.all('SELECT * FROM booking_details WHERE booking_id = ?', [bookingId]);
        
        // Get payment information
        const paymentInfo = await db.get('SELECT * FROM payments WHERE booking_id = ?', [bookingId]);
        
        res.json({
            booking,
            departureFlight: formatFlightForClient(departureFlight),
            returnFlight: returnFlight ? formatFlightForClient(returnFlight) : null,
            passengers,
            paymentInfo
        });
    } catch (error) {
        console.error('Error fetching booking:', error);
        res.status(500).json({ error: 'Failed to fetch booking details' });
    }
});

// Update booking payment status
app.patch('/api/bookings/:id/payment', async (req, res) => {
    try {
        const bookingId = req.params.id;
        const { paymentStatus } = req.body;
        
        if (!paymentStatus) {
            return res.status(400).json({ error: 'Payment status is required' });
        }
        
        // Get current booking information to check previous status
        const currentBooking = await db.get('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        
        if (!currentBooking) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        // Handle promotion code usage when the booking status changes to paid
        if (paymentStatus === 'paid' && currentBooking.payment_status !== 'paid' && currentBooking.promo_code) {
            // Get promotion details
            const promo = await db.get('SELECT * FROM promotions WHERE code = ?', [currentBooking.promo_code]);
            
            if (promo) {
                // Update promo used count to ensure it's counted
                await db.run('UPDATE promotions SET used_count = used_count + 1 WHERE promo_id = ?', [promo.promo_id]);
                console.log(`Promo code ${currentBooking.promo_code} usage confirmed with payment. Count incremented.`);
            }
        }
        
        // Check if we're cancelling or refunding a previously paid booking
        if ((paymentStatus === 'cancelled' || paymentStatus === 'refunded') && 
            (currentBooking.payment_status === 'paid' || currentBooking.payment_status === 'unpaid')) {
            
            // Get the number of passengers in this booking
            const passengerCount = await db.get('SELECT COUNT(*) as count FROM booking_details WHERE booking_id = ?', [bookingId]);
            
            // Get the seat class used in the booking
            const seatClass = currentBooking.travel_class || 'ECONOMY';
            
            // Determine which seat field to update based on the seat class
            let seatField;
            switch(seatClass) {
                case 'PREMIUM_ECONOMY':
                    seatField = 'seats_premium_economy';
                    break;
                case 'BUSINESS':
                    seatField = 'seats_business';
                    break;
                case 'FIRST':
                    seatField = 'seats_first';
                    break;
                case 'ECONOMY':
                default:
                    seatField = 'seats_economy';
                    break;
            }
            
            // Restore the seats to the flights - both class-specific and total
            await db.run(`
                UPDATE flights SET 
                ${seatField} = ${seatField} + ?,
                available_seats = available_seats + ? 
                WHERE flight_id = ?
            `, [passengerCount.count, passengerCount.count, currentBooking.departure_flight_id]);
            
            // If this was a round trip, restore seats for the return flight too
            if (currentBooking.is_round_trip === 1 && currentBooking.return_flight_id) {
                await db.run(`
                    UPDATE flights SET 
                    ${seatField} = ${seatField} + ?,
                    available_seats = available_seats + ? 
                    WHERE flight_id = ?
                `, [passengerCount.count, passengerCount.count, currentBooking.return_flight_id]);
            }
        }
        
        const result = await db.run(
            'UPDATE bookings SET payment_status = ? WHERE booking_id = ?',
            [paymentStatus, bookingId]
        );
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        res.json({ success: true, message: 'Payment status updated successfully' });
    } catch (error) {
        console.error('Error updating payment status:', error);
        res.status(500).json({ error: 'Failed to update payment status' });
    }
});

// Promotions API endpoints
app.get('/api/promotions', async (req, res) => {
    try {
        // Get query parameters
        const { code, status, type } = req.query;
        
        // Change this to get ALL promotions, not just valid ones
        let query = 'SELECT * FROM promotions';
        const params = [];
        
        // Apply filters if provided
        if (code) {
            query += ' WHERE code LIKE ?';
            params.push(`%${code}%`);
        } else {
            query += ' WHERE 1=1'; // Always true condition for consistent query structure
        }
        
        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }
        
        if (type) {
            // Map UI type to database discount_type
            let discount_type;
            if (type === 'percentage') {
                discount_type = 'percent';
            } else {
                discount_type = type;
            }
            query += ' AND discount_type = ?';
            params.push(discount_type);
        }
        
        // Get all promotions without filtering by expiration date
        const promotions = await db.all(query, params);
        
        // Process promotions to update status based on dates
        const currentDate = new Date();
        const processedPromotions = promotions.map(promo => {
            const validTo = new Date(promo.valid_to);
            const validFrom = new Date(promo.valid_from);
            
            // Create a copy to avoid modifying the database object directly
            const updatedPromo = {...promo};
            
            // Update status based on dates
            if (validTo < currentDate) {
                // If end date has passed, mark as expired
                updatedPromo.status = 'expired';
            } else if (validFrom > currentDate) {
                // If start date is in future, mark as scheduled
                updatedPromo.status = 'scheduled';
            }
            
            return updatedPromo;
        });
        
        res.json(processedPromotions);
    } catch (error) {
        console.error('Error fetching promotions:', error);
        res.status(500).json({ error: 'Failed to fetch promotions' });
    }
});

// Add endpoint to delete a promotion
app.post('/api/promotions/delete', async (req, res) => {
    try {
        const { promo_id } = req.body;
        
        if (!promo_id) {
            return res.status(400).json({ error: 'Promotion ID is required' });
        }
        
        // Check if promotion exists
        const promotion = await db.get('SELECT * FROM promotions WHERE promo_id = ?', [promo_id]);
        
        if (!promotion) {
            return res.status(404).json({ error: 'Promotion not found' });
        }
        
        // Delete the promotion
        await db.run('DELETE FROM promotions WHERE promo_id = ?', [promo_id]);
        
        res.json({ success: true, message: 'Promotion deleted successfully' });
    } catch (error) {
        console.error('Error deleting promotion:', error);
        res.status(500).json({ error: 'Failed to delete promotion' });
    }
});

// Add endpoint to create a new promotion
app.post('/api/promotions/create', async (req, res) => {
    try {
        const {
            code, name, description, type, discount_type, discount_value,
            valid_from, valid_to, usage_limit, status
        } = req.body;
        
        // Basic validation
        if (!code || !name || (!type && !discount_type) || discount_value === undefined) {
            return res.status(400).json({ error: 'Missing required promotion information' });
        }
        
        // Check if promotion code already exists
        const existingPromo = await db.get('SELECT * FROM promotions WHERE code = ?', [code]);
        if (existingPromo) {
            return res.status(400).json({ error: 'Promotion code already exists' });
        }
        
        // Map type field to discount_type if needed
        const finalDiscountType = discount_type || (type === 'percentage' ? 'percent' : type);
        
        // Default status to 'active' if not provided
        const promoStatus = status || 'active';
        
        // Insert new promotion
        const result = await db.run(`
            INSERT INTO promotions (
                code, name, description, discount_type, discount_value,
                valid_from, valid_to, usage_limit, used_count, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [
            code, name, description, finalDiscountType, discount_value,
            valid_from, valid_to, usage_limit, promoStatus
        ]);
        
        // Get the newly created promotion
        const newPromotion = await db.get('SELECT * FROM promotions WHERE promo_id = ?', result.lastID);
        
        res.status(201).json(newPromotion);
    } catch (error) {
        console.error('Error creating promotion:', error);
        res.status(500).json({ error: 'Failed to create promotion' });
    }
});

// Add endpoint to update an existing promotion
app.post('/api/promotions/update', async (req, res) => {
    try {
        const {
            promo_id, code, name, description, type, discount_type, discount_value,
            valid_from, valid_to, usage_limit, status
        } = req.body;
        
        if (!promo_id || !code || !name || (!type && !discount_type) || discount_value === undefined) {
            return res.status(400).json({ error: 'Missing required promotion information' });
        }
        
        // Check if promotion exists
        const existingPromo = await db.get('SELECT * FROM promotions WHERE promo_id = ?', [promo_id]);
        if (!existingPromo) {
            return res.status(404).json({ error: 'Promotion not found' });
        }
        
        // Check if updated code conflicts with another promotion
        const codeConflict = await db.get('SELECT * FROM promotions WHERE code = ? AND promo_id != ?', [code, promo_id]);
        if (codeConflict) {
            return res.status(400).json({ error: 'Promotion code already exists' });
        }
        
        // Map type field to discount_type if needed
        const finalDiscountType = discount_type || (type === 'percentage' ? 'percent' : type);
        
        // Default to existing status if not provided
        const promoStatus = status || existingPromo.status || 'active';
        
        // Update the promotion
        await db.run(`
            UPDATE promotions SET
                code = ?, name = ?, description = ?, discount_type = ?, discount_value = ?,
                valid_from = ?, valid_to = ?, usage_limit = ?, status = ?
            WHERE promo_id = ?
        `, [
            code, name, description, finalDiscountType, discount_value,
            valid_from, valid_to, usage_limit, promoStatus, promo_id
        ]);
        
        // Get the updated promotion
        const updatedPromotion = await db.get('SELECT * FROM promotions WHERE promo_id = ?', promo_id);
        
        res.json(updatedPromotion);
    } catch (error) {
        console.error('Error updating promotion:', error);
        res.status(500).json({ error: 'Failed to update promotion' });
    }
});

// Endpoint to validate promotion code
app.post('/api/promotions/validate', async (req, res) => {
    try {
        const { code } = req.body;
        
        if (!code) {
            return res.status(400).json({ error: 'Promotion code is required' });
        }
        
        // Get the promotion regardless of dates
        const promo = await db.get(
            'SELECT * FROM promotions WHERE code = ? AND status != "inactive" AND used_count < usage_limit',
            [code]
        );
        
        if (!promo) {
            return res.status(404).json({ error: 'Invalid or inactive promotion code' });
        }
        
        // Check dates manually
        const currentDate = new Date();
        const validFrom = new Date(promo.valid_from);
        const validTo = new Date(promo.valid_to);
        
        if (currentDate < validFrom) {
            return res.status(404).json({ error: 'Promotion code is not valid yet' });
        }
        
        if (currentDate > validTo) {
            return res.status(404).json({ error: 'Promotion code has expired' });
        }
        
        res.json({
            valid: true,
            promo: {
                code: promo.code,
                name: promo.name,
                description: promo.description,
                discountType: promo.discount_type,
                discountValue: promo.discount_value,
                status: promo.status
            }
        });
    } catch (error) {
        console.error('Error validating promotion:', error);
        res.status(500).json({ error: 'Failed to validate promotion code' });
    }
});

// Admin API: Get all bookings
app.get('/api/admin/bookings', async (req, res) => {
    try {
        const { bookingId, contactName, paymentStatus, fromDate, toDate } = req.query;
        
        let query = `
            SELECT b.*, 
                  (SELECT COUNT(*) FROM booking_details WHERE booking_id = b.booking_id) as passenger_count
            FROM bookings b
            WHERE 1=1
        `;
        const params = [];

        if (bookingId) {
            query += ' AND b.booking_id = ?';
            params.push(bookingId);
        }

        if (contactName) {
            query += ' AND b.contact_name LIKE ?';
            params.push(`%${contactName}%`);
        }

        if (paymentStatus) {
            query += ' AND b.payment_status = ?';
            params.push(paymentStatus);
        }

        if (fromDate) {
            query += ' AND DATE(b.booking_time) >= DATE(?)';
            params.push(fromDate);
        }

        if (toDate) {
            query += ' AND DATE(b.booking_time) <= DATE(?)';
            params.push(toDate);
        }

        query += ' ORDER BY b.booking_time DESC';
        
        const bookings = await db.all(query, params);
        
        // Add flight information to each booking
        for (const booking of bookings) {
            // Get departure flight information
            const departureFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', booking.departure_flight_id);
            if (departureFlight) {
                booking.flight_info = {
                    airline: departureFlight.airline,
                    airline_code: departureFlight.airline_code,
                    flight_number: departureFlight.flight_number,
                    departure_airport: departureFlight.departure_airport,
                    arrival_airport: departureFlight.arrival_airport
                };
            }
            
            // Add return flight info only if this is a round-trip booking and has a return flight
            if (booking.is_round_trip === 1 && booking.return_flight_id) {
                const returnFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', booking.return_flight_id);
                if (returnFlight) {
                    booking.return_flight_info = {
                        airline: returnFlight.airline,
                        airline_code: returnFlight.airline_code,
                        flight_number: returnFlight.flight_number,
                        departure_airport: returnFlight.departure_airport,
                        arrival_airport: returnFlight.arrival_airport
                };
                }
            }
        }
        
        res.json(bookings);
    } catch (error) {
        console.error('Error fetching bookings:', error);
        res.status(500).json({ error: 'Failed to fetch bookings' });
    }
});

// Admin API: Get booking details
app.get('/api/admin/bookings/:id', async (req, res) => {
    try {
        const bookingId = req.params.id;
        
        // Get booking information
        const booking = await db.get('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        
        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        // Parse passenger counts if available
        let passengerCounts = null;
        if (booking.passengers_info) {
            try {
                passengerCounts = JSON.parse(booking.passengers_info);
            } catch (e) {
                console.error('Error parsing passenger counts:', e);
            }
        }
        
        // Get departure flight details
        const departureFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', [booking.departure_flight_id]);
        
        // Get return flight details if this is a round-trip booking
        let returnFlight = null;
        if (booking.is_round_trip === 1 && booking.return_flight_id) {
            returnFlight = await db.get('SELECT * FROM flights WHERE flight_id = ?', [booking.return_flight_id]);
        }
        
        // Get passengers
        const passengers = await db.all('SELECT * FROM booking_details WHERE booking_id = ?', [bookingId]);
        
        // Get payment information
        let paymentInfo = null;
        try {
            paymentInfo = await db.get('SELECT * FROM payments WHERE booking_id = ?', [bookingId]);
        } catch (e) {
            console.error('Error fetching payment information:', e);
        }
        
        res.json({
            booking,
            passengerCounts,
            departureFlight: departureFlight ? formatFlightForClient(departureFlight) : null,
            returnFlight: returnFlight ? formatFlightForClient(returnFlight) : null,
            passengers,
            paymentInfo
        });
    } catch (error) {
        console.error('Error fetching booking details:', error);
        res.status(500).json({ error: 'Failed to fetch booking details' });
    }
});

// Admin API: Update booking payment status
app.patch('/api/admin/bookings/:id/payment', async (req, res) => {
    try {
        const bookingId = req.params.id;
        const { paymentStatus } = req.body;
        
        if (!paymentStatus) {
            return res.status(400).json({ error: 'Payment status is required' });
        }
        
        // Validate payment status
        const validStatuses = ['unpaid', 'paid', 'refunded', 'cancelled'];
        if (!validStatuses.includes(paymentStatus)) {
            return res.status(400).json({ error: 'Invalid payment status' });
        }
        
        // Get current booking information to check previous status
        const currentBooking = await db.get('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        
        if (!currentBooking) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        // Handle promotion code usage when the booking status changes to paid
        if (paymentStatus === 'paid' && currentBooking.payment_status !== 'paid' && currentBooking.promo_code) {
            // Get promotion details
            const promo = await db.get('SELECT * FROM promotions WHERE code = ?', [currentBooking.promo_code]);
            
            if (promo) {
                // Update promo used count to ensure it's counted
                await db.run('UPDATE promotions SET used_count = used_count + 1 WHERE promo_id = ?', [promo.promo_id]);
                console.log(`Promo code ${currentBooking.promo_code} usage confirmed with payment. Count incremented.`);
            }
        }
        
        // Check if we're cancelling or refunding a previously paid booking
        if ((paymentStatus === 'cancelled' || paymentStatus === 'refunded') && 
            (currentBooking.payment_status === 'paid' || currentBooking.payment_status === 'unpaid')) {
            
            // Get the number of passengers in this booking
            const passengerCount = await db.get('SELECT COUNT(*) as count FROM booking_details WHERE booking_id = ?', [bookingId]);
            
            // Get the seat class used in the booking
            const seatClass = currentBooking.travel_class || 'ECONOMY';
            
            // Determine which seat field to update based on the seat class
            let seatField;
            switch(seatClass) {
                case 'PREMIUM_ECONOMY':
                    seatField = 'seats_premium_economy';
                    break;
                case 'BUSINESS':
                    seatField = 'seats_business';
                    break;
                case 'FIRST':
                    seatField = 'seats_first';
                    break;
                case 'ECONOMY':
                default:
                    seatField = 'seats_economy';
                    break;
            }
            
            // Restore the seats to the flights - both class-specific and total
            await db.run(`
                UPDATE flights SET 
                ${seatField} = ${seatField} + ?,
                available_seats = available_seats + ? 
                WHERE flight_id = ?
            `, [passengerCount.count, passengerCount.count, currentBooking.departure_flight_id]);
            
            // If this was a round trip, restore seats for the return flight too
            if (currentBooking.is_round_trip === 1 && currentBooking.return_flight_id) {
                await db.run(`
                    UPDATE flights SET 
                    ${seatField} = ${seatField} + ?,
                    available_seats = available_seats + ? 
                    WHERE flight_id = ?
                `, [passengerCount.count, passengerCount.count, currentBooking.return_flight_id]);
            }
        }
        
        // Update booking payment status
        const result = await db.run(
            'UPDATE bookings SET payment_status = ? WHERE booking_id = ?',
            [paymentStatus, bookingId]
        );
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }

                // Removed automatic seat assignment logic
        
        res.json({ 
            success: true, 
            message: 'Payment status updated successfully',
            paymentStatus 
        });
    } catch (error) {
        console.error('Error updating payment status:', error);
        res.status(500).json({ error: 'Failed to update payment status' });
    }
});

// Helper function for assign seats removed

// Admin API: Get booking statistics
app.get('/api/admin/stats/bookings', async (req, res) => {
    try {
        // Get booking count by payment status
        const statusStats = await db.all(`
            SELECT payment_status, COUNT(*) as count 
            FROM bookings 
            GROUP BY payment_status 
            ORDER BY count DESC
        `);
        
        // Get total revenue
        const revenue = await db.get(`
            SELECT SUM(total_amount) as total 
            FROM bookings 
            WHERE payment_status = 'paid'
        `);
        
        // Get bookings by travel class
        const travelClassStats = await db.all(`
            SELECT travel_class, COUNT(*) as count 
            FROM bookings 
            GROUP BY travel_class
        `);
        
        // Get recent bookings (last 7 days)
        const recentBookings = await db.all(`
            SELECT DATE(booking_time) as date, COUNT(*) as count 
            FROM bookings 
            WHERE booking_time >= datetime('now', '-7 days')
            GROUP BY DATE(booking_time)
            ORDER BY date
        `);
        
        res.json({
            totalBookings: statusStats.reduce((acc, stat) => acc + stat.count, 0),
            totalRevenue: revenue.total || 0,
            statusStats,
            travelClassStats,
            recentBookings
        });
    } catch (error) {
        console.error('Error fetching booking statistics:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// Add new endpoint to save/update payment information
app.post('/api/payments', async (req, res) => {
    try {
        const { bookingId, method, transactionInfo } = req.body;
        
        if (!bookingId || !method) {
            return res.status(400).json({ error: 'Missing required payment information' });
        }
        
        // Validate payment method
        if (method !== 'bank_transfer' && method !== 'momo') {
            return res.status(400).json({ error: 'Invalid payment method' });
        }
        
        // Check if booking exists
        const existingBooking = await db.get('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        if (!existingBooking) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        // Check if payment already exists
        const existingPayment = await db.get('SELECT * FROM payments WHERE booking_id = ?', [bookingId]);
        
        if (existingPayment) {
            // Update existing payment
            await db.run(`
                UPDATE payments 
                SET method = ?, transaction_info = ?, payment_date = CURRENT_TIMESTAMP
                WHERE booking_id = ?
            `, [method, transactionInfo || null, bookingId]);
        } else {
            // Insert new payment
            await db.run(`
                INSERT INTO payments (
                    booking_id, method, transaction_info
                ) VALUES (?, ?, ?)
            `, [bookingId, method, transactionInfo || null]);
        }
        
        // Also update booking payment status to 'pending'
        await db.run(`
            UPDATE bookings 
            SET payment_status = 'pending'
            WHERE booking_id = ?
        `, [bookingId]);
        
        res.json({ 
            success: true, 
            message: 'Payment information saved successfully'
        });
    } catch (error) {
        console.error('Error saving payment information:', error);
        res.status(500).json({ error: 'Failed to save payment information' });
    }
});

// Get payment information for a booking
app.get('/api/payments/:bookingId', async (req, res) => {
    try {
        const bookingId = req.params.bookingId;
        
        // Check if booking exists
        const existingBooking = await db.get('SELECT * FROM bookings WHERE booking_id = ?', [bookingId]);
        if (!existingBooking) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        
        // Get payment information
        const payment = await db.get('SELECT * FROM payments WHERE booking_id = ?', [bookingId]);
        
        if (!payment) {
            return res.status(404).json({ error: 'Payment information not found' });
        }
        
        res.json(payment);
    } catch (error) {
        console.error('Error fetching payment information:', error);
        res.status(500).json({ error: 'Failed to fetch payment information' });
    }
});

// Helper functions
function formatDateForDB(dateString) {
    // Convert from YYYY-MM-DD to YYYY-MM-DD (for SQLite date format)
    const [year, month, day] = dateString.split('-');
    return `${year}-${month}-${day}`;
}

function formatFlightForClient(flight) {
    // Parse available classes từ string
    let availableClasses;
    try {
        // Thử chuyển đổi từ JSON string nếu đó là định dạng lưu trữ
        availableClasses = JSON.parse(flight.available_classes);
    } catch (error) {
        // Nếu không phải JSON, xử lý như một string phân cách bằng dấu phẩy
        availableClasses = flight.available_classes.split(',');
    }
    
    // Extract date from departure_time
    const departureDate = new Date(flight.departure_time);
    const day = String(departureDate.getDate()).padStart(2, '0');
    const month = String(departureDate.getMonth() + 1).padStart(2, '0');
    const year = departureDate.getFullYear();
    const formattedDate = `${day}-${month}-${year}`;
    
    // Extract hours and minutes from departure_time and arrival_time
    const departureHours = String(departureDate.getHours()).padStart(2, '0');
    const departureMinutes = String(departureDate.getMinutes()).padStart(2, '0');
    const departureTime = `${departureHours}:${departureMinutes}`;
    
    const arrivalDate = new Date(flight.arrival_time);
    const arrivalHours = String(arrivalDate.getHours()).padStart(2, '0');
    const arrivalMinutes = String(arrivalDate.getMinutes()).padStart(2, '0');
    const arrivalTime = `${arrivalHours}:${arrivalMinutes}`;
    
    // For compatibility with old code, use economy price as the base price
    const basePrice = flight.price_economy || flight.price || 0;
    
    return {
        id: `${flight.airline_code}${flight.flight_number}`,
        flight_id: flight.flight_id,
        airline: flight.airline,
        airline_code: flight.airline_code,
        airlineCode: flight.airline_code,
        flight_number: flight.flight_number,
        departure: flight.departure_airport,
        departure_airport: flight.departure_airport,
        destination: flight.arrival_airport,
        arrival_airport: flight.arrival_airport,
        departureTime: departureTime,
        departure_time: flight.departure_time,
        arrivalTime: arrivalTime,
        arrival_time: flight.arrival_time,
        duration: flight.duration,
        // Include both the legacy price field and the new class-specific prices
        price: basePrice,
        price_economy: flight.price_economy || basePrice,
        price_premium_economy: flight.price_premium_economy || null,
        price_business: flight.price_business || null,
        price_first: flight.price_first || null,
        // Create a prices object for easy access
        prices: {
            ECONOMY: flight.price_economy || basePrice,
            PREMIUM_ECONOMY: flight.price_premium_economy || null,
            BUSINESS: flight.price_business || null,
            FIRST: flight.price_first || null
        },
        // Include seats for each class
        seats_economy: flight.seats_economy || 0,
        seats_premium_economy: flight.seats_premium_economy || 0,
        seats_business: flight.seats_business || 0, 
        seats_first: flight.seats_first || 0,
        // Create a seats object for easy access
        seats: {
            ECONOMY: flight.seats_economy || 0,
            PREMIUM_ECONOMY: flight.seats_premium_economy || 0,
            BUSINESS: flight.seats_business || 0,
            FIRST: flight.seats_first || 0
        },
        availableSeats: flight.available_seats,
        available_seats: flight.available_seats,
        status: flight.status,
        availableClasses: availableClasses,
        available_classes: flight.available_classes,
        flightClass: 'Economy', // Default display class
        date: formattedDate
    };
}

// Sample data population function
async function populateSampleFlights() {
    const airlines = [
        { 
            code: 'VN', 
            name: 'Vietnam Airlines', 
            classes: ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'],
            seatsConfig: {
                ECONOMY: { min: 100, max: 150 },
                PREMIUM_ECONOMY: { min: 30, max: 50 },
                BUSINESS: { min: 20, max: 30 },
                FIRST: { min: 8, max: 12 }
            }
        },
        { 
            code: 'VJ', 
            name: 'Vietjet Air', 
            classes: ['ECONOMY', 'PREMIUM_ECONOMY'],
            seatsConfig: {
                ECONOMY: { min: 150, max: 180 },
                PREMIUM_ECONOMY: { min: 20, max: 30 }
            }
        },
        { 
            code: 'BL', 
            name: 'Jetstar Pacific', 
            classes: ['ECONOMY'],
            seatsConfig: {
                ECONOMY: { min: 150, max: 200 }
            }
        },
        { 
            code: 'QH', 
            name: 'Bamboo Airways', 
            classes: ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS'],
            seatsConfig: {
                ECONOMY: { min: 120, max: 160 },
                PREMIUM_ECONOMY: { min: 20, max: 40 },
                BUSINESS: { min: 10, max: 20 }
            }
        }
    ];
    
    const routes = [
        { departure: 'HAN', destination: 'SGN' },
        { departure: 'SGN', destination: 'HAN' },
        { departure: 'HAN', destination: 'DAD' },
        { departure: 'DAD', destination: 'HAN' },
        { departure: 'SGN', destination: 'DAD' },
        { departure: 'DAD', destination: 'SGN' }
    ];

    const startDate = new Date(2025, 5, 1); // June 1, 2025 (month is 0-indexed)
    const endDate = new Date(2025, 6, 1);   // July 1, 2025
    
    const stmt = await db.prepare(`
        INSERT INTO flights (
            airline, airline_code, flight_number, departure_airport, arrival_airport, 
            departure_time, arrival_time, duration, 
            price_economy, price_premium_economy, price_business, price_first,
            seats_economy, seats_premium_economy, seats_business, seats_first,
            available_seats, status, available_classes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let flightCounter = 1000;
    
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        for (let i = 0; i < 10; i++) {
            const airlineInfo = airlines[Math.floor(Math.random() * airlines.length)];
            const routeInfo = routes[Math.floor(Math.random() * routes.length)];
            
            const depHour = Math.floor(Math.random() * 18) + 6; // Departure between 06:00 and 23:00
            const depMinute = Math.floor(Math.random() * 4) * 15; // Minutes: 00, 15, 30, 45
            
            const departureDateTime = new Date(d);
            departureDateTime.setHours(depHour, depMinute, 0);
            
            const durationHours = Math.floor(Math.random() * 2) + 1; // Duration 1 to 2 hours
            const durationMinutes = Math.floor(Math.random() * 4) * 15; // Duration minutes
            
            const arrivalDateTime = new Date(departureDateTime);
            arrivalDateTime.setHours(
                departureDateTime.getHours() + durationHours,
                departureDateTime.getMinutes() + durationMinutes
            );
            
            const durationStr = `${durationHours}h ${durationMinutes > 0 ? `${durationMinutes}m` : ''}`.trim();
            
            // Base economy price from 500,000 to 2,000,000
            const economyPrice = Math.floor(Math.random() * 1500000) + 500000;
            
            // Calculate prices for other seat classes with some randomness
            // These are now independent prices rather than strict multipliers
            const premiumEconomyPrice = airlineInfo.classes.includes('PREMIUM_ECONOMY') ? 
                Math.floor(economyPrice * (1.3 + Math.random() * 0.4)) : null;
                
            const businessPrice = airlineInfo.classes.includes('BUSINESS') ? 
                Math.floor(economyPrice * (2.2 + Math.random() * 0.6)) : null;
                
            const firstPrice = airlineInfo.classes.includes('FIRST') ? 
                Math.floor(economyPrice * (3.5 + Math.random() * 1.0)) : null;
            
            // Generate seat quantities for each class
            const seatsEconomy = airlineInfo.classes.includes('ECONOMY') ? 
                Math.floor(Math.random() * (airlineInfo.seatsConfig.ECONOMY.max - airlineInfo.seatsConfig.ECONOMY.min + 1)) + airlineInfo.seatsConfig.ECONOMY.min : 0;
                
            const seatsPremiumEconomy = airlineInfo.classes.includes('PREMIUM_ECONOMY') ?
                Math.floor(Math.random() * (airlineInfo.seatsConfig.PREMIUM_ECONOMY.max - airlineInfo.seatsConfig.PREMIUM_ECONOMY.min + 1)) + airlineInfo.seatsConfig.PREMIUM_ECONOMY.min : 0;
                
            const seatsBusiness = airlineInfo.classes.includes('BUSINESS') ?
                Math.floor(Math.random() * (airlineInfo.seatsConfig.BUSINESS.max - airlineInfo.seatsConfig.BUSINESS.min + 1)) + airlineInfo.seatsConfig.BUSINESS.min : 0;
                
            const seatsFirst = airlineInfo.classes.includes('FIRST') ?
                Math.floor(Math.random() * (airlineInfo.seatsConfig.FIRST.max - airlineInfo.seatsConfig.FIRST.min + 1)) + airlineInfo.seatsConfig.FIRST.min : 0;
            
            // Calculate total available seats
            const totalSeats = seatsEconomy + seatsPremiumEconomy + seatsBusiness + seatsFirst;
            
            let flightAvailableClasses = [...airlineInfo.classes].sort(() => 0.5 - Math.random())
                .slice(0, Math.floor(Math.random() * airlineInfo.classes.length) + 1);
            
            // Ensure 'ECONOMY' is usually present
            if (airlineInfo.classes.includes('ECONOMY') && !flightAvailableClasses.includes('ECONOMY')) {
                if (Math.random() < 0.8) { // 80% chance to add ECONOMY
                    flightAvailableClasses.push('ECONOMY');
                }
            }
            
            // Ensure there's at least one class, and remove duplicates
            flightAvailableClasses = [...new Set(flightAvailableClasses)];
            if (flightAvailableClasses.length === 0) {
                if (airlineInfo.classes.includes('ECONOMY')) {
                    flightAvailableClasses = ['ECONOMY'];
                } else if (airlineInfo.classes.length > 0) {
                    flightAvailableClasses = [airlineInfo.classes[0]];
                } else {
                    flightAvailableClasses = ['ECONOMY'];
                }
            }
            
            const flightNumber = String(flightCounter++);
            
            // Lưu available_classes dưới dạng chuỗi (không phải JSON)
            const availableClassesString = flightAvailableClasses.join(',');
            
            await stmt.run(
                airlineInfo.name,
                airlineInfo.code,
                flightNumber,
                routeInfo.departure,
                routeInfo.destination,
                departureDateTime.toISOString(),
                arrivalDateTime.toISOString(),
                durationStr,
                economyPrice,
                premiumEconomyPrice,
                businessPrice,
                firstPrice,
                seatsEconomy,
                seatsPremiumEconomy,
                seatsBusiness,
                seatsFirst,
                totalSeats,
                'scheduled',
                availableClassesString
            );
        }
    }
    
    await stmt.finalize();
    console.log('Sample flights added to the database.');
}

// Helper function to generate booking number
function generateBookingNumber() {
    const timestamp = new Date().getTime().toString().slice(-8);
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `FV${timestamp}${random}`;
}

// Helper function to get price multiplier based on passenger type
function getPriceMultiplierForPassengerType(passengerType) {
    const multipliers = {
        'ADULT': 1,      // Người lớn: 100% giá vé
        'CHILD': 0.75,   // Trẻ em: 75% giá vé
        'INFANT': 0.1    // Em bé: 10% giá vé
    };
    return multipliers[passengerType] || 1;
}

// Helper function to determine passenger type based on date of birth
function determinePassengerTypeFromDOB(dobString) {
    if (!dobString) return 'ADULT'; // Mặc định là người lớn nếu không có ngày sinh
    
    try {
        const dob = new Date(dobString);
        const today = new Date();
        const ageInYears = (today - dob) / (365.25 * 24 * 60 * 60 * 1000);
        
        if (ageInYears < 2) {
            return 'INFANT'; // Em bé dưới 2 tuổi
        } else if (ageInYears < 12) {
            return 'CHILD';  // Trẻ em từ 2 đến dưới 12 tuổi
        } else {
            return 'ADULT';  // Người lớn từ 12 tuổi trở lên
        }
    } catch (error) {
        console.error('Error determining passenger type from DOB:', error);
        return 'ADULT'; // Mặc định là người lớn nếu có lỗi xảy ra
    }
}

// Sample promotions data
async function populateSamplePromotions() {
    const promotions = [
        {
            code: 'SUMMER25',
            name: 'Khuyến mãi mùa hè',
            description: 'Giảm 25% cho tất cả các chuyến bay trong mùa hè',
            discount_type: 'percent',
            discount_value: 25,
            valid_from: '2025-06-01',
            valid_to: '2025-08-31',
            usage_limit: 100,
            status: 'scheduled'
        },
        {
            code: 'WELCOME10',
            name: 'Ưu đãi chào mừng',
            description: 'Giảm 10% cho lần đặt vé đầu tiên',
            discount_type: 'percent',
            discount_value: 10,
            valid_from: '2025-01-01',
            valid_to: '2025-12-31',
            usage_limit: 500,
            status: 'active'
        },
        {
            code: 'FIXED200K',
            name: 'Giảm 200K',
            description: 'Giảm 200,000 VND cho mọi đơn hàng',
            discount_type: 'fixed',
            discount_value: 200000,
            valid_from: '2025-05-01',
            valid_to: '2025-07-31',
            usage_limit: 50,
            status: 'active'
        }
    ];
    
    for (const promo of promotions) {
        await db.run(`
            INSERT INTO promotions (
                code, name, description, discount_type, discount_value,
                valid_from, valid_to, usage_limit, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            promo.code,
            promo.name,
            promo.description,
            promo.discount_type,
            promo.discount_value,
            promo.valid_from,
            promo.valid_to,
            promo.usage_limit,
            promo.status
        ]);
    }
    
    console.log('Sample promotions added to the database.');
}

// Helper functions for seat generation removed

// Generate random booking ID with 10 characters (uppercase letters and numbers)
function generateBookingId() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 10; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// Initialize database and start server
setupDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
            
            // Schedule the first status update
            setTimeout(updatePromotionStatuses, 1000);
            
            // Then run the status update every hour
            setInterval(updatePromotionStatuses, 60 * 60 * 1000);
        });
    })
    .catch(error => {
        console.error('Failed to setup database:', error);
        process.exit(1);
    }); 

// Function to update promotion statuses based on dates
async function updatePromotionStatuses() {
    try {
        console.log('Updating promotion statuses based on dates...');
        const currentDate = new Date().toISOString();
        
        // Update expired promotions
        await db.run(`
            UPDATE promotions 
            SET status = 'expired' 
            WHERE valid_to < ? AND status != 'expired' AND status != 'inactive'
        `, [currentDate]);
        
        // Update scheduled promotions that are now active
        await db.run(`
            UPDATE promotions 
            SET status = 'active' 
            WHERE valid_from <= ? AND valid_to >= ? AND status = 'scheduled'
        `, [currentDate, currentDate]);
        
        console.log('Promotion statuses updated successfully');
    } catch (error) {
        console.error('Error updating promotion statuses:', error);
    }
} 

// Admin API: Get statistics data
app.get('/api/admin/statistics', async (req, res) => {
    try {
        const { fromDate, toDate } = req.query;
        
        if (!fromDate || !toDate) {
            return res.status(400).json({ error: 'fromDate and toDate are required parameters' });
        }
        
        // Format dates to ensure they are in correct format
        const formattedFromDate = fromDate.includes('T') ? fromDate : `${fromDate}T00:00:00.000Z`;
        const formattedToDate = toDate.includes('T') ? toDate : `${toDate}T23:59:59.999Z`;
        
        // Get core statistics from our helper function
        const coreStats = await getStatisticsForPeriod(formattedFromDate, formattedToDate);
        
        // Get revenue by date
        const revenueByDateQuery = await db.all(`
            SELECT 
                DATE(booking_time) as date, 
                SUM(total_amount) as amount 
            FROM bookings 
            WHERE payment_status = 'paid' AND booking_time BETWEEN ? AND ?
            GROUP BY DATE(booking_time)
            ORDER BY date
        `, [formattedFromDate, formattedToDate]);
        
        // Ensure we have valid data
        const revenueByDate = revenueByDateQuery || [];
        
        // Get bookings by date
        const bookingsByDateQuery = await db.all(`
            SELECT 
                DATE(booking_time) as date, 
                COUNT(*) as count 
            FROM bookings 
            WHERE booking_time BETWEEN ? AND ?
            GROUP BY DATE(booking_time)
            ORDER BY date
        `, [formattedFromDate, formattedToDate]);
        
        // Ensure we have valid data
        const bookingsByDate = bookingsByDateQuery || [];
        
        // Get bookings by status
        const bookingsByStatusQuery = await db.all(`
            SELECT 
                payment_status as status, 
                COUNT(*) as count 
            FROM bookings 
            WHERE booking_time BETWEEN ? AND ?
            GROUP BY payment_status
        `, [formattedFromDate, formattedToDate]);
        
        // Ensure we have valid data
        const bookingsByStatus = bookingsByStatusQuery || [];
        
        // Get popular routes based on bookings
        const popularRoutesQuery = await db.all(`
            SELECT 
                f.departure_airport as departure, 
                f.arrival_airport as destination, 
                COUNT(b.booking_id) as count,
                SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END) as revenue,
                (
                    (
                        SELECT COUNT(*) 
                        FROM booking_details bd 
                        JOIN bookings b2 ON bd.booking_id = b2.booking_id 
                        WHERE b2.departure_flight_id = f.flight_id AND b2.payment_status = 'paid'
                    ) * 100.0 / NULLIF(f.seats_economy, 0)
                ) as occupancyRate
            FROM bookings b
            JOIN flights f ON b.departure_flight_id = f.flight_id
            WHERE b.booking_time BETWEEN ? AND ?
            GROUP BY f.departure_airport, f.arrival_airport
            ORDER BY count DESC
        `, [formattedFromDate, formattedToDate]);
        
        // Ensure we have valid data and handle missing values
        const popularRoutes = (popularRoutesQuery || []).map(route => ({
            departure: route.departure,
            destination: route.destination,
            count: route.count || 0,
            revenue: route.revenue || 0,
            occupancyRate: route.occupancyRate || 0
        }));
        
        // Format the response
        const response = {
            ...coreStats,
            revenueByDate,
            bookingsByDate,
            bookingsByStatus,
            popularRoutes
        };
        
        res.json(response);
    } catch (error) {
        console.error('Error fetching statistics:', error);
        // Return a minimal valid response with default values
        res.status(200).json({
            totalBookings: 0,
            totalRevenue: 0,
            totalPassengers: 0,
            occupancyRate: 0,
            revenueByDate: [],
            bookingsByDate: [],
            bookingsByStatus: [],
            popularRoutes: []
        });
    }
});

// Admin API: Export statistics
app.get('/api/admin/statistics/export', async (req, res) => {
    try {
        const { format, fromDate, toDate } = req.query;
        
        if (!format || !fromDate || !toDate) {
            return res.status(400).json({ error: 'format, fromDate and toDate are required parameters' });
        }
        
        // Format dates to ensure they are in correct format
        const formattedFromDate = fromDate.includes('T') ? fromDate : `${fromDate}T00:00:00.000Z`;
        const formattedToDate = toDate.includes('T') ? toDate : `${toDate}T23:59:59.999Z`;
        
        // Get statistics data for the report
        const coreStats = await getStatisticsForPeriod(formattedFromDate, formattedToDate);
        
        // Get revenue by date
        const revenueByDate = await db.all(`
            SELECT 
                DATE(booking_time) as date, 
                SUM(total_amount) as amount 
            FROM bookings 
            WHERE payment_status = 'paid' AND booking_time BETWEEN ? AND ?
            GROUP BY DATE(booking_time)
            ORDER BY date
        `, [formattedFromDate, formattedToDate]) || [];
        
        // Get bookings by date
        const bookingsByDate = await db.all(`
            SELECT 
                DATE(booking_time) as date, 
                COUNT(*) as count 
            FROM bookings 
            WHERE booking_time BETWEEN ? AND ?
            GROUP BY DATE(booking_time)
            ORDER BY date
        `, [formattedFromDate, formattedToDate]) || [];
        
        // Get bookings by status
        const bookingsByStatus = await db.all(`
            SELECT 
                payment_status as status, 
                COUNT(*) as count 
            FROM bookings 
            WHERE booking_time BETWEEN ? AND ?
            GROUP BY payment_status
        `, [formattedFromDate, formattedToDate]) || [];
        
        // Get popular routes based on bookings
        const popularRoutesQuery = await db.all(`
            SELECT 
                f.departure_airport as departure, 
                f.arrival_airport as destination, 
                COUNT(b.booking_id) as count,
                SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount ELSE 0 END) as revenue
            FROM bookings b
            JOIN flights f ON b.departure_flight_id = f.flight_id
            WHERE b.booking_time BETWEEN ? AND ?
            GROUP BY f.departure_airport, f.arrival_airport
            ORDER BY count DESC
        `, [formattedFromDate, formattedToDate]);
        
        // Format popular routes data
        const popularRoutes = (popularRoutesQuery || []).map(route => ({
            departure: route.departure,
            destination: route.destination,
            count: route.count || 0,
            revenue: route.revenue || 0
        }));
        
        // Format the response data
        const reportData = {
            reportTitle: `Báo cáo thống kê từ ${fromDate} đến ${toDate}`,
            generatedDate: new Date().toLocaleString('vi-VN'),
            period: {
                fromDate,
                toDate
            },
            coreStats: {
                totalBookings: coreStats.totalBookings,
                totalRevenue: coreStats.totalRevenue,
                totalPassengers: coreStats.totalPassengers
            },
            revenueByDate,
            bookingsByDate,
            bookingsByStatus,
            popularRoutes
        };
        
        // Return JSON data for now (both formats)
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=statistics-${fromDate}-to-${toDate}.json`);
        res.json(reportData);
        
        /* 
        // In a production environment, we would generate actual PDF and Excel files
        if (format === 'pdf') {
            // Example with pdfkit (would need to npm install pdfkit)
            const PDFDocument = require('pdfkit');
            const doc = new PDFDocument();
            
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=statistics-${fromDate}-to-${toDate}.pdf`);
            
            doc.pipe(res);
            
            // Add content to PDF
            doc.fontSize(25).text(reportData.reportTitle, 100, 100);
            doc.fontSize(12).text(`Ngày tạo: ${reportData.generatedDate}`, 100, 150);
            
            // Core stats
            doc.fontSize(16).text('Thống kê tổng quan', 100, 200);
            doc.fontSize(12).text(`Tổng đơn đặt vé: ${reportData.coreStats.totalBookings}`, 120, 230);
            doc.fontSize(12).text(`Doanh thu: ${formatCurrency(reportData.coreStats.totalRevenue)}`, 120, 250);
            doc.fontSize(12).text(`Số hành khách: ${reportData.coreStats.totalPassengers}`, 120, 270);
            
            // Add tables for detailed data
            // ...
            
            doc.end();
        } else if (format === 'excel') {
            // Example with exceljs (would need to npm install exceljs)
            const Excel = require('exceljs');
            const workbook = new Excel.Workbook();
            const worksheet = workbook.addWorksheet('Thống kê');
            
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=statistics-${fromDate}-to-${toDate}.xlsx`);
            
            // Add headers
            worksheet.columns = [
                { header: 'Chỉ số', key: 'metric', width: 30 },
                { header: 'Giá trị', key: 'value', width: 20 }
            ];
            
            // Add core stats
            worksheet.addRow({ metric: 'Tổng đơn đặt vé', value: reportData.coreStats.totalBookings });
            worksheet.addRow({ metric: 'Doanh thu', value: reportData.coreStats.totalRevenue });
            worksheet.addRow({ metric: 'Số hành khách', value: reportData.coreStats.totalPassengers });
            
            // Add revenue by date
            worksheet.addRow({});
            worksheet.addRow({ metric: 'Doanh thu theo ngày' });
            worksheet.addRow({ metric: 'Ngày', value: 'Doanh thu' });
            
            reportData.revenueByDate.forEach(item => {
                worksheet.addRow({ metric: item.date, value: item.amount });
            });
            
            // Add more data
            // ...
            
            await workbook.xlsx.write(res);
        }
        */
    } catch (error) {
        console.error('Error exporting statistics:', error);
        res.status(500).json({ error: 'Failed to export statistics', details: error.message });
    }
});

// Admin API: Get comparison statistics
app.get('/api/admin/statistics/compare', async (req, res) => {
    try {
        const { currentFromDate, currentToDate, previousFromDate, previousToDate } = req.query;
        
        if (!currentFromDate || !currentToDate || !previousFromDate || !previousToDate) {
            return res.status(400).json({ 
                error: 'Missing required parameters',
                requiredParams: ['currentFromDate', 'currentToDate', 'previousFromDate', 'previousToDate']
            });
        }
        
        // Format dates
        const formatDate = (date) => date.includes('T') ? date : `${date}T00:00:00.000Z`;
        
        const formattedCurrentFromDate = formatDate(currentFromDate);
        const formattedCurrentToDate = formatDate(currentToDate);
        const formattedPreviousFromDate = formatDate(previousFromDate);
        const formattedPreviousToDate = formatDate(previousToDate);
        
        // Get current period metrics
        const currentStats = await getStatisticsForPeriod(formattedCurrentFromDate, formattedCurrentToDate);
        
        // Get previous period metrics
        const previousStats = await getStatisticsForPeriod(formattedPreviousFromDate, formattedPreviousToDate);
        
        // Calculate percentage changes
        const changes = {
            bookingsChange: calculatePercentageChange(currentStats.totalBookings, previousStats.totalBookings),
            revenueChange: calculatePercentageChange(currentStats.totalRevenue, previousStats.totalRevenue),
            passengersChange: calculatePercentageChange(currentStats.totalPassengers, previousStats.totalPassengers),
            occupancyChange: calculatePercentageChange(currentStats.occupancyRate, previousStats.occupancyRate)
        };
        
        res.json({
            current: currentStats,
            previous: previousStats,
            changes
        });
    } catch (error) {
        console.error('Error fetching comparison statistics:', error);
        res.status(500).json({ error: 'Failed to fetch comparison statistics', details: error.message });
    }
});

// Helper function to get statistics for a specific time period
async function getStatisticsForPeriod(fromDate, toDate) {
    try {
        // Get total bookings
        const totalBookingsQuery = await db.get(`
            SELECT COUNT(*) as count 
            FROM bookings 
            WHERE booking_time BETWEEN ? AND ?
        `, [fromDate, toDate]);
        
        const totalBookings = totalBookingsQuery ? (totalBookingsQuery.count || 0) : 0;
        
        // Get revenue from paid bookings
        const totalRevenueQuery = await db.get(`
            SELECT SUM(total_amount) as total 
            FROM bookings 
            WHERE payment_status = 'paid' AND booking_time BETWEEN ? AND ?
        `, [fromDate, toDate]);
        
        const totalRevenue = totalRevenueQuery && totalRevenueQuery.total !== null ? totalRevenueQuery.total : 0;
        
        // Get total passengers
        const totalPassengersQuery = await db.get(`
            SELECT COUNT(*) as count 
            FROM booking_details bd
            JOIN bookings b ON bd.booking_id = b.booking_id
            WHERE b.booking_time BETWEEN ? AND ?
        `, [fromDate, toDate]);
        
        const totalPassengers = totalPassengersQuery ? (totalPassengersQuery.count || 0) : 0;
        
        // Get occupancy data
        const occupancyRateQuery = await db.all(`
            SELECT 
                f.flight_id,
                f.seats_economy,
                (SELECT COUNT(*) FROM booking_details bd JOIN bookings b ON bd.booking_id = b.booking_id 
                 WHERE b.departure_flight_id = f.flight_id AND b.travel_class = 'ECONOMY' AND b.booking_time BETWEEN ? AND ?) as booked_seats
            FROM flights f
            WHERE f.departure_time BETWEEN ? AND ?
        `, [fromDate, toDate, fromDate, toDate]);
        
        // Calculate occupancy rate
        let totalOccupancy = 0;
        let flightCount = 0;
        
        if (occupancyRateQuery && occupancyRateQuery.length > 0) {
            occupancyRateQuery.forEach(flight => {
                if (flight.seats_economy > 0) {
                    const rate = (flight.booked_seats / flight.seats_economy) * 100;
                    totalOccupancy += rate;
                    flightCount++;
                }
            });
        }
        
        const occupancyRate = flightCount > 0 ? totalOccupancy / flightCount : 0;
        
        console.log('Statistics calculated for period:', { fromDate, toDate, totalBookings, totalRevenue, totalPassengers, occupancyRate });
        
        return {
            totalBookings,
            totalRevenue,
            totalPassengers,
            occupancyRate
        };
    } catch (error) {
        console.error('Error calculating statistics:', error);
        // Return default values if there's an error
        return {
            totalBookings: 0,
            totalRevenue: 0,
            totalPassengers: 0,
            occupancyRate: 0
        };
    }
}

// Helper function to calculate percentage change
function calculatePercentageChange(current, previous) {
    if (previous === 0) {
        return current > 0 ? 100 : 0;
    }
    return ((current - previous) / previous) * 100;
}