# Handoff: New ERP Application for Heat-Treating / Metal-Processing Job Shops

## Overview

Build a new, modern ERP application for a heat-treating / metal-processing job shop.

This is **not a redesign of Visual Shop** and should not be treated as a Visual Shop clone. Visual Shop is only a **reference point** for understanding the current business environment, workflow expectations, terminology, and legacy pain points.

The new ERP should support the full operational lifecycle of a job shop:

Quote → Order → Schedule → Track → Certify → Ship → Invoice

It should also include customer management, part management, process/recipe management, certifications, specifications, standards, invoicing, accounts receivable, reporting, and administrative setup.

The primary product goal is to create a clean, modern, workflow-driven ERP that removes the complexity of legacy menu-heavy systems. The application should feel purpose-built for shop-floor, production, sales, quality, and office/accounting users.

## Important Framing

Visual Shop is a **reference only**.

Use it to understand:

- Common ERP workflows in a heat-treat / metal-processing shop
- Business entities such as quotes, work orders, parts, process masters, certifications, invoices, and A/R
- Legacy navigation problems, especially deeply nested menus
- Domain terminology and operational expectations

Do **not** assume:

- The new system must connect to a Visual Shop database
- The new system must preserve Visual Shop’s data model
- The new system must match Visual Shop’s legacy screens
- Visual Shop modules, menus, or architecture should be rebuilt one-for-one
- Any unspecified legacy behavior should be recreated automatically

When a requirement is unclear, ask for clarification instead of filling in gaps with assumptions.

## Product Direction

The new ERP should use a modern application structure:

- A flat, workflow-grouped sidebar with no nested sub-menus
- A command palette for quickly jumping to modules or actions
- Role-based dashboards for different user types
- Consistent list, detail, editor, form, table, status, loading, and error states
- A clean UI suitable for production, sales, quality, finance, and management users

The application should be designed around the work users are trying to complete, not around legacy menu structures.

## Target Users / Roles

The application should support role-based experiences for at least:

- Plant Manager
- Estimator / Sales
- Office / Accounting
- Production / Shop Floor users
- Quality users
- Administrative setup users

Permissions and role-based access control should be part of the product design, but the exact permission model should be defined for the new application rather than copied directly from Visual Shop.

## Core Scope

The new ERP should include these major areas:

### Dashboard / Today

Role-based start screen showing the most important operational information for the selected user type.

Examples:

- Open orders
- Late orders
- On-time percentage
- Open quotes
- Revenue month-to-date
- Open A/R
- Certs awaiting release
- Billing queue
- Shop-floor activity

### Sales

Includes:

- Quotes list
- Quote builder
- Customers
- Customer record
- Customer contacts
- Customer pricing
- Customer order and quote history

### Production

Includes:

- Orders list
- Order detail
- Process steps / traveler view
- Process master / recipe management
- Scheduling
- Tracking
- Shop floor equipment view

### Quality

Includes:

- Certifications
- Specifications
- Standards

Quality scope is limited to certifications, specifications, and standards unless additional requirements are provided.

### Finance

Includes:

- Invoicing
- Accounts receivable
- Aging views
- Period close workflow
- Reports

### Setup / Configuration

Includes:

- Operators and security
- Plant setup
- Equipment and areas
- Pricing and price keys
- Certification forms
- Process master configuration

## Explicitly Out of Scope Unless Later Requested

Do not build these unless they are specifically added back into scope:

- SSI / Super Systems furnace integration
- SCADA or live furnace telemetry
- Corrective Action Reports
- Maintenance management

Furnace and equipment status should be represented from scheduling and tracking data unless live integration requirements are provided later.

## Design Reference

The provided HTML design files are visual and interaction references only.

They show the intended:

- Layout
- Navigation model
- Screen structure
- Visual style
- Component states
- Interaction patterns
- Dashboard concepts
- List/detail/editor patterns

They are **not production code** and should not be copied directly.

Ignore any prototype-only runtime or support files. Rebuild the application natively using the selected front-end framework, component library, routing approach, state management, and data layer.

If no technical stack has been chosen yet, ask for the preferred stack before implementation.

## UX Principles

The application should prioritize:

- Fast navigation
- Clear operational visibility
- Minimal menu depth
- Consistent screen patterns
- Strong status communication
- Easy access to common actions
- Production-friendly readability
- Clear separation between list, detail, edit, and dashboard experiences

The system should avoid the legacy ERP problem of burying actions inside multiple layers of menus.

## App Shell

Use a two-column app shell:

- Fixed left sidebar
- Main content column
- Sticky top bar
- Scrollable content area

The sidebar should be flat and grouped by workflow area, not nested.

Recommended sidebar groups:

- Today
- Sales
  - Quotes
  - Customers
  - Part Maintenance
- Production
  - Orders
  - Process Master
  - Schedule
  - Tracking
  - Shop Floor
- Quality
  - Certifications
  - Specifications
  - Standards
- Finance
  - Invoicing
  - A/R
  - Reports
- Setup
- Patterns / Design System

Detail screens should keep their parent navigation item active. For example, an order detail screen should keep Orders active.

## Command Palette

Include a command palette triggered by keyboard shortcut and search buttons.

The command palette should allow users to:

- Navigate to modules
- Start common actions
- Create new records
- Search available destinations by label or group

It should support:

- Open / close behavior
- Keyboard shortcut
- Escape to close
- Empty state when no matches are found
- Grouped results

## Common Screen Patterns

### List Screens

List screens should generally include:

- Page title
- Subtitle or helper description
- Filter button
- Primary action button
- Card-based table
- Mono-style identifiers
- Status pills
- Clickable rows leading to detail screens

### Detail / Editor Screens

Detail and editor screens should generally include:

- Back link
- Header with title
- Status pill
- Primary and secondary actions
- Main content area
- Right-side summary rail where useful
- Consistent two-column layout for complex records

### Forms

Forms should include:

- Clear labels
- Validation states
- Inline errors
- Disabled states
- Success states where relevant
- Error summary for invalid submissions
- Disabled submit until required fields are valid

### Loading and Error States

The application should include:

- Skeleton loading states
- Recoverable error panels
- Retry actions
- Empty states for lists with no data

## Key Screens

### Today Dashboard

Role-based dashboard with variants for:

- Manager
- Sales
- Office / Accounting

Each variant should show the most relevant KPIs, operational queues, alerts, and activity summaries for that role.

### Quotes

Include:

- Quote list
- Quote builder
- Customer and part section
- Pricing lines
- Notes and terms
- Quote summary
- Customer snapshot

### Customers

Include:

- Customer list
- Customer record
- Overview
- Contacts
- Parts
- Orders
- Documents
- Pricing

### Part Maintenance

Include:

- Part list
- Part editor
- Customer association
- Material
- Drawing revision
- Hardness
- Case depth
- Specification
- Assigned process master
- Pricing information
- Inspection requirements

### Process Master

Process Master represents the standard recipe or routing.

Include:

- Process master list
- Process master editor
- Ordered process steps
- Equipment or area assignment
- Tracking labels
- Instructions
- Parameters
- Inspection requirements
- Used-by parts list

Process steps should live in the Process Master, not directly on individual part records, unless a separate override model is explicitly defined.

### Orders

Include:

- Orders list
- Order detail
- Work order information
- Customer and part details
- Quantity
- Due date
- Status
- Process traveler
- Step status
- Pricing breakdown
- Certification status
- Activity feed

### Schedule

Include a production schedule view organized by equipment or area.

The initial design reference uses a week-board style layout with equipment lanes and load blocks.

### Tracking

Include a scan-driven tracking view organized by production area.

The initial design reference uses a kanban-style board with cards moving through operational stages.

### Shop Floor

Include an equipment-focused view showing:

- Equipment status
- Current load
- Work order
- Customer
- Quantity
- Progress
- Operator
- Last scan
- Idle equipment

### Quality

Include lists for:

- Certifications
- Specifications
- Standards

Certification records should support pending and released states.

### Invoicing and A/R

Include:

- Invoicing list
- Unbilled work
- Sent invoices
- Paid invoices
- A/R aging
- Customer balances
- Period close action with confirmation dialog

### Reports

Use a grouped report launcher instead of legacy nested report menus.

Suggested groups:

- Sales
- Accounts Receivable
- Production & Tracking
- Quotes

### Setup

Use a flat grid of setup cards instead of nested maintenance menus.

Suggested setup areas:

- Operators & Security
- Plant Setup
- Process Masters
- Equipment & Areas
- Pricing & Price Keys
- Certifications & Forms

## Data Model Guidance

Design a new data model appropriate for the new ERP.

Core entities likely include:

- Customer
- Contact
- Part
- Process Master
- Process Step
- Quote
- Quote Line
- Work Order
- Order Line / Part Line
- Equipment
- Area
- Tracking Event
- Certification
- Specification
- Standard
- Invoice
- A/R Balance
- Operator / User
- Role / Permission
- Price Key
- Pricing Rule

Do not assume this must match Visual Shop’s database structure.

If migration from an existing system is required, ask for the source system, migration scope, data quality expectations, and whether the migration is one-time or ongoing.

## Business Logic Areas Requiring Clarification

Before implementing these areas, ask for detailed business rules:

- Pricing
- Customer-specific price overrides
- Quote approval limits
- Tax handling
- Certification generation
- Certification release rules
- Inspection requirements
- Tracking rules
- Auto-track-in / auto-track-out behavior
- Holds
- Rework
- Split lots
- Partial shipments
- Invoicing rules
- A/R period close
- Permission model
- User roles
- Audit history

Do not invent business rules that are not specified.

## Recommended Build Order

Recommended implementation sequence:

1. Core app shell, navigation, routing, and design system
2. Authentication and role-based access model
3. Vertical slice: Quote → Order → Order detail → Invoice
4. Production workflows: Orders, Tracking, Schedule, Shop Floor
5. Reference data: Customers, Parts, Process Masters
6. Quality: Certifications, Specifications, Standards
7. Finance: Invoicing, A/R, Reports
8. Setup and administrative configuration
9. Advanced workflow automation and integrations, if later required

## Clarification Rule

If a requirement is missing, ambiguous, or open to multiple interpretations, do not assume the answer.

Ask for clarification before making product, architecture, workflow, data model, or business-rule decisions.

Examples of things that require clarification:

- Target technology stack
- Whether this is single-tenant or multi-tenant
- Whether legacy data migration is required
- Which roles and permissions are required at launch
- Which workflows must be included in MVP
- Which integrations are required
- Which reports are mandatory
- Which business rules are fixed versus configurable

## Final Goal

Create a new ERP application that gives a heat-treating / metal-processing job shop a modern, clear, workflow-based operating system.

The result should use the Visual Shop reference only to understand the domain and pain points, while designing and building a new product with its own architecture, data model, user experience, and implementation approach.
