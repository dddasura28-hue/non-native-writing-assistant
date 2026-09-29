use windows::core::GUID;

/// Development-only identity for the prototype COM text service.
pub const TEXT_SERVICE_CLSID: GUID = GUID::from_u128(0x9aa7d37d_0ec6_4dbd_a871_4f3359c9c981);

/// Development-only English (United States) TSF language profile.
pub const EN_US_PROFILE_GUID: GUID = GUID::from_u128(0xd13a7292_5762_4ee8_b28b_18369600e14a);

/// Development-only Chinese (Simplified, China) TSF language profile.
pub const ZH_CN_PROFILE_GUID: GUID = GUID::from_u128(0x868be9ae_116b_4bf1_81a0_cac6c5891d38);

pub const EN_US_LANGID: u16 = 0x0409;
pub const ZH_CN_LANGID: u16 = 0x0804;

pub const SERVICE_DESCRIPTION: &str = "Non-native Writing TSF Prototype (Development)";

pub fn clsid_registry_name() -> String {
    format!(
        "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
        TEXT_SERVICE_CLSID.data1,
        TEXT_SERVICE_CLSID.data2,
        TEXT_SERVICE_CLSID.data3,
        TEXT_SERVICE_CLSID.data4[0],
        TEXT_SERVICE_CLSID.data4[1],
        TEXT_SERVICE_CLSID.data4[2],
        TEXT_SERVICE_CLSID.data4[3],
        TEXT_SERVICE_CLSID.data4[4],
        TEXT_SERVICE_CLSID.data4[5],
        TEXT_SERVICE_CLSID.data4[6],
        TEXT_SERVICE_CLSID.data4[7]
    )
}
