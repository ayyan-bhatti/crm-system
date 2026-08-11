# Build Log

## Project
AI Assisted CRM / Inventory System (SimpleCRM). A multi user CRM and inventory app with authentication, role based access, CRUD for customers, products and orders, search and filtering, and a natural language search feature powered by the Anthropic API.

## Stack
React (Vite) and Tailwind CSS on the frontend, Node.js and Express on the backend, MongoDB with Mongoose for the database, JWT and bcrypt for auth, Jest and Supertest for testing. Deployed on Vercel using their multi service setup so the frontend and backend ship from a single project.

## Approach

I planned the project before touching code. I picked MERN since that is my background, and mapped out the core entities first: User, Customer, Product and Order, then decided on three roles (admin, manager, sales_rep) with different levels of access. Admins can manage everything including users, managers can do full CRUD on customers, products and orders, and sales reps only see and manage their own customers and orders.

I built it in stages: auth and role middleware first, then customer and product CRUD with search and filtering, then orders with stock adjustment logic, then the AI search feature, then tests, then deployment.

## How I used AI

I used Claude Code as my main coding assistant for this project. I gave it a detailed spec covering the data models, auth rules, role permissions, API structure and the AI feature requirement, and had it scaffold the backend first (models, controllers, routes, middleware) and then the frontend pages. I reviewed the generated code as it came in rather than accepting it blindly, checked that the role based access logic actually matched what I wanted, and asked it to explain parts I wasn't sure about before moving on.

For the AI assisted feature itself, I built a natural language search endpoint. A user can type something like "customers in Karachi with no orders in the last 30 days" and the backend sends that query plus a description of the available fields to the Anthropic API, which returns a structured filter object. That gets converted into a Mongoose query. If the AI call fails for any reason, the endpoint falls back to a basic keyword search instead of breaking, since a search feature that just errors out isn't good enough.

I also used Claude for writing the automated tests, and to help debug the deployment once the app was live.

## Testing

Backend tests cover registration and login, role based access checks (making sure a sales rep actually gets blocked from other people's records), and CRUD operations on customers and orders. Tests run against an in memory MongoDB instance so they don't touch the real database.

## Deployment and debugging

Deployment turned out to be the hardest part of this project, more than the actual coding. I deployed to Vercel using their newer multi service config so one project serves both the React frontend and the Express backend from the same domain. After deploying, registration was failing with a 500 error and visiting some routes directly returned a 404.

I added a health check endpoint that reports whether the database is connected and lists any missing configuration, which made the actual problem obvious: I had never added my environment variables (MONGO_URI, JWT_SECRET, CLIENT_ORIGIN) to the Vercel project. Locally these come from a .env file, but that file is gitignored on purpose and never reaches the deployed server, so production had no database connection string and no JWT secret at all.

I set up a MongoDB Atlas cluster, created a database user, opened network access so Vercel's servers could reach it, generated a proper JWT secret, and added everything through Vercel's environment variable settings, then redeployed. After that the health check came back clean and the app worked end to end.

## What I'd do differently

If I started over I'd set up the hosted database and Vercel environment variables before writing any code, instead of leaving deployment for the end. It would have caught this issue much earlier and saved time at the end of the project.
