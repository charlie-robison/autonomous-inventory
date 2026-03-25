import SwiftUI

// MARK: - Color(hex:) Extension

extension Color {
    init(hex: UInt, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

// MARK: - Theme

enum Theme {
    static let background = Color(hex: 0x0A0A0F)

    // Text hierarchy (white at various opacities)
    static let textPrimary = Color.white.opacity(0.9)
    static let textSecondary = Color.white.opacity(0.7)
    static let textTertiary = Color.white.opacity(0.5)
    static let textMuted = Color.white.opacity(0.3)
    static let textFaint = Color.white.opacity(0.2)

    // Card / surface styles
    static let cardBackground = Color.white.opacity(0.03)
    static let cardBorder = Color.white.opacity(0.06)
    static let glassBackground = Color.white.opacity(0.08)
    static let glassBorder = Color.white.opacity(0.12)
    static let glassBorderLight = Color.white.opacity(0.10)

    // Error
    static let errorBackground = Color(hex: 0xEF4444, opacity: 0.10)
    static let errorBorder = Color(hex: 0xEF4444, opacity: 0.20)
    static let errorText = Color(hex: 0xF87171)

    // Red (processing)
    static let red400 = Color(hex: 0xF87171)
}

// MARK: - Mode Colors

struct ModeColors {
    let badgeBackground: Color
    let badgeBorder: Color
    let badgeText: Color
    let dotColor: Color
    let dotGlow: Color
    let accentButton: Color
    let accentButtonText: Color
    let statusBackground: Color
    let statusBorder: Color
    let statusText: Color
}

extension ModeColors {
    static func forMode(_ mode: AppMode) -> ModeColors {
        switch mode {
        case .count:
            return ModeColors(
                badgeBackground: Color(hex: 0x10B981, opacity: 0.20),
                badgeBorder: Color(hex: 0x10B981, opacity: 0.30),
                badgeText: Color(hex: 0x6EE7B7),
                dotColor: Color(hex: 0x34D399),
                dotGlow: Color(hex: 0x34D399, opacity: 0.6),
                accentButton: Color(hex: 0x10B981),
                accentButtonText: .white,
                statusBackground: Color(hex: 0x10B981, opacity: 0.10),
                statusBorder: Color(hex: 0x10B981, opacity: 0.20),
                statusText: Color(hex: 0x6EE7B7)
            )
        case .receive:
            return ModeColors(
                badgeBackground: Color(hex: 0x3B82F6, opacity: 0.20),
                badgeBorder: Color(hex: 0x3B82F6, opacity: 0.30),
                badgeText: Color(hex: 0x93C5FD),
                dotColor: Color(hex: 0x60A5FA),
                dotGlow: Color(hex: 0x60A5FA, opacity: 0.6),
                accentButton: Color(hex: 0x3B82F6),
                accentButtonText: .white,
                statusBackground: Color(hex: 0x3B82F6, opacity: 0.10),
                statusBorder: Color(hex: 0x3B82F6, opacity: 0.20),
                statusText: Color(hex: 0x93C5FD)
            )
        case .load:
            return ModeColors(
                badgeBackground: Color(hex: 0xF59E0B, opacity: 0.20),
                badgeBorder: Color(hex: 0xF59E0B, opacity: 0.30),
                badgeText: Color(hex: 0xFCD34D),
                dotColor: Color(hex: 0xFBBF24),
                dotGlow: Color(hex: 0xFBBF24, opacity: 0.6),
                accentButton: Color(hex: 0xF59E0B),
                accentButtonText: .black,
                statusBackground: Color(hex: 0xF59E0B, opacity: 0.10),
                statusBorder: Color(hex: 0xF59E0B, opacity: 0.20),
                statusText: Color(hex: 0xFCD34D)
            )
        }
    }
}
