use crate::identity::{
    EN_US_LANGID, EN_US_PROFILE_GUID, TEXT_SERVICE_CLSID, ZH_CN_LANGID, ZH_CN_PROFILE_GUID,
};
use std::fmt::{self, Display, Formatter};
use windows::core::{GUID, HRESULT};
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::UI::TextServices::GUID_TFCAT_TIP_KEYBOARD;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum Profile {
    English,
    SimplifiedChinese,
}

impl Profile {
    pub(crate) const ALL: [Self; 2] = [Self::English, Self::SimplifiedChinese];

    pub(crate) const fn language(self) -> u16 {
        match self {
            Self::English => EN_US_LANGID,
            Self::SimplifiedChinese => ZH_CN_LANGID,
        }
    }

    pub(crate) const fn guid(self) -> GUID {
        match self {
            Self::English => EN_US_PROFILE_GUID,
            Self::SimplifiedChinese => ZH_CN_PROFILE_GUID,
        }
    }

    pub(crate) const fn description_suffix(self) -> &'static str {
        match self {
            Self::English => "English",
            Self::SimplifiedChinese => "Chinese",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum Stage {
    ValidateDllPath,
    CoInitializeEx,
    ComRegistryProbe,
    ComRegistryWrite,
    ComRegistryVerify,
    ComRegistryRemove,
    ProfilesCreate,
    ServiceProbe,
    ServiceRegister,
    ServiceUnregister,
    ProfileProbe(Profile),
    ProfileAdd(Profile),
    ProfileEnabledProbe(Profile),
    ProfileEnable(Profile),
    ProfileDisable(Profile),
    ProfileRemove(Profile),
    CategoryManagerCreate,
    CategoryProbe,
    CategoryRegister,
    CategoryUnregister,
}

impl Stage {
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::ValidateDllPath => "DLL-path.validate",
            Self::CoInitializeEx => "CoInitializeEx",
            Self::ComRegistryProbe => "COM.InprocServer32.probe",
            Self::ComRegistryWrite => "COM.InprocServer32.write",
            Self::ComRegistryVerify => "COM.InprocServer32.verify",
            Self::ComRegistryRemove => "COM.CLSID.remove",
            Self::ProfilesCreate => "ITfInputProcessorProfiles.create",
            Self::ServiceProbe => "ITfInputProcessorProfiles.service-probe",
            Self::ServiceRegister => "ITfInputProcessorProfiles.Register",
            Self::ServiceUnregister => "ITfInputProcessorProfiles.Unregister",
            Self::ProfileProbe(_) => "LanguageProfile.probe",
            Self::ProfileAdd(_) => "AddLanguageProfile",
            Self::ProfileEnabledProbe(_) => "IsEnabledLanguageProfile",
            Self::ProfileEnable(_) => "EnableLanguageProfile",
            Self::ProfileDisable(_) => "DisableLanguageProfile",
            Self::ProfileRemove(_) => "RemoveLanguageProfile",
            Self::CategoryManagerCreate => "ITfCategoryMgr.create",
            Self::CategoryProbe => "ITfCategoryMgr.category-probe",
            Self::CategoryRegister => "RegisterCategory",
            Self::CategoryUnregister => "UnregisterCategory",
        }
    }

    fn detail(self) -> String {
        match self {
            Self::ProfileProbe(profile)
            | Self::ProfileAdd(profile)
            | Self::ProfileEnabledProbe(profile)
            | Self::ProfileEnable(profile)
            | Self::ProfileDisable(profile)
            | Self::ProfileRemove(profile) => format!(
                " language=0x{:04X} profile={}",
                profile.language(),
                format_guid(profile.guid())
            ),
            Self::CategoryProbe | Self::CategoryRegister | Self::CategoryUnregister => format!(
                " category={} service={}",
                format_guid(GUID_TFCAT_TIP_KEYBOARD),
                format_guid(TEXT_SERVICE_CLSID)
            ),
            Self::ServiceProbe | Self::ServiceRegister | Self::ServiceUnregister => {
                format!(" service={}", format_guid(TEXT_SERVICE_CLSID))
            }
            _ => String::new(),
        }
    }

    fn summary_fields(self) -> Vec<(&'static str, String)> {
        match self {
            Self::ProfileProbe(profile)
            | Self::ProfileAdd(profile)
            | Self::ProfileEnabledProbe(profile)
            | Self::ProfileEnable(profile)
            | Self::ProfileDisable(profile)
            | Self::ProfileRemove(profile) => vec![
                ("language", format!("0x{:04X}", profile.language())),
                ("profile", format_guid(profile.guid())),
            ],
            Self::CategoryProbe | Self::CategoryRegister | Self::CategoryUnregister => vec![
                ("category", format_guid(GUID_TFCAT_TIP_KEYBOARD)),
                ("service", format_guid(TEXT_SERVICE_CLSID)),
            ],
            Self::ServiceProbe | Self::ServiceRegister | Self::ServiceUnregister => {
                vec![("service", format_guid(TEXT_SERVICE_CLSID))]
            }
            _ => Vec::new(),
        }
    }
}

fn format_guid(guid: GUID) -> String {
    format!(
        "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
        guid.data1,
        guid.data2,
        guid.data3,
        guid.data4[0],
        guid.data4[1],
        guid.data4[2],
        guid.data4[3],
        guid.data4[4],
        guid.data4[5],
        guid.data4[6],
        guid.data4[7]
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OperationError {
    pub(crate) hresult: HRESULT,
    pub(crate) message: String,
}

impl OperationError {
    pub(crate) fn new(hresult: HRESULT, message: impl Into<String>) -> Self {
        Self {
            hresult,
            message: sanitize_message(&message.into()),
        }
    }
}

fn sanitize_message(message: &str) -> String {
    let message = message.replace(['\r', '\n'], " ");
    let trimmed = message.trim();
    if trimmed.is_empty() {
        "No Windows error message was available".to_owned()
    } else {
        trimmed.to_owned()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExistingComRegistration {
    Absent,
    Exact,
    Conflicting,
}

pub(crate) trait RegistrationBackend {
    fn initialize_com(&mut self) -> Result<(), OperationError>;
    fn probe_com_registration(
        &mut self,
        expected_dll_path: &str,
    ) -> Result<ExistingComRegistration, OperationError>;
    fn write_com_registration(&mut self, dll_path: &str) -> Result<(), OperationError>;
    fn verify_com_registration(&mut self, dll_path: &str) -> Result<(), OperationError>;
    fn com_registration_exists(&mut self) -> Result<bool, OperationError>;
    fn remove_com_registration(&mut self) -> Result<(), OperationError>;

    fn create_profiles(&mut self) -> Result<(), OperationError>;
    fn service_registered(&mut self) -> Result<bool, OperationError>;
    fn register_service(&mut self) -> Result<(), OperationError>;
    fn unregister_service(&mut self) -> Result<(), OperationError>;
    fn profile_registered(&mut self, profile: Profile) -> Result<bool, OperationError>;
    fn add_profile(&mut self, profile: Profile) -> Result<(), OperationError>;
    fn profile_enabled(&mut self, profile: Profile) -> Result<bool, OperationError>;
    fn set_profile_enabled(
        &mut self,
        profile: Profile,
        enabled: bool,
    ) -> Result<(), OperationError>;
    fn remove_profile(&mut self, profile: Profile) -> Result<(), OperationError>;

    fn create_category_manager(&mut self) -> Result<(), OperationError>;
    fn category_registered(&mut self) -> Result<bool, OperationError>;
    fn register_category(&mut self) -> Result<(), OperationError>;
    fn unregister_category(&mut self) -> Result<(), OperationError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommandKind {
    Register,
    Unregister,
}

impl Display for CommandKind {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Register => formatter.write_str("registration"),
            Self::Unregister => formatter.write_str("unregistration"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DiagnosticStatus {
    Ok,
    Skip,
    Fail,
    RollbackOk,
    RollbackFail,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    status: DiagnosticStatus,
    stage: Stage,
    error: Option<OperationError>,
    note: Option<&'static str>,
}

impl Diagnostic {
    fn ok(stage: Stage) -> Self {
        Self {
            status: DiagnosticStatus::Ok,
            stage,
            error: None,
            note: None,
        }
    }

    fn skip(stage: Stage, note: &'static str) -> Self {
        Self {
            status: DiagnosticStatus::Skip,
            stage,
            error: None,
            note: Some(note),
        }
    }

    fn fail(stage: Stage, error: OperationError) -> Self {
        Self {
            status: DiagnosticStatus::Fail,
            stage,
            error: Some(error),
            note: None,
        }
    }

    fn rollback(stage: Stage, result: &Result<(), OperationError>) -> Self {
        match result {
            Ok(()) => Self {
                status: DiagnosticStatus::RollbackOk,
                stage,
                error: None,
                note: None,
            },
            Err(error) => Self {
                status: DiagnosticStatus::RollbackFail,
                stage,
                error: Some(error.clone()),
                note: None,
            },
        }
    }
}

impl Display for Diagnostic {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        let prefix = match self.status {
            DiagnosticStatus::Ok => "[ok]",
            DiagnosticStatus::Skip => "[skip]",
            DiagnosticStatus::Fail => "[fail]",
            DiagnosticStatus::RollbackOk => "[rollback-ok]",
            DiagnosticStatus::RollbackFail => "[rollback-fail]",
        };
        write!(
            formatter,
            "{prefix} {}{}",
            self.stage.name(),
            self.stage.detail()
        )?;
        if let Some(note) = self.note {
            write!(formatter, " ({note})")?;
        }
        if let Some(error) = &self.error {
            write!(
                formatter,
                " HRESULT=0x{:08X} message={}",
                error.hresult.0 as u32, error.message
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandReport {
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandFailure {
    command: CommandKind,
    stage: Stage,
    error: OperationError,
    pub diagnostics: Vec<Diagnostic>,
}

impl CommandFailure {
    pub(crate) fn new(
        command: CommandKind,
        stage: Stage,
        error: OperationError,
        diagnostics: Vec<Diagnostic>,
    ) -> Self {
        Self {
            command,
            stage,
            error,
            diagnostics,
        }
    }

    pub fn stage(&self) -> &'static str {
        self.stage.name()
    }

    pub fn hresult(&self) -> u32 {
        self.error.hresult.0 as u32
    }

    pub fn message(&self) -> &str {
        &self.error.message
    }

    pub fn detail_fields(&self) -> Vec<(&'static str, String)> {
        self.stage.summary_fields()
    }
}

impl Display for CommandFailure {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        writeln!(formatter, "TSF {} failed", self.command)?;
        writeln!(formatter, "stage: {}", self.stage())?;
        for (name, value) in self.detail_fields() {
            writeln!(formatter, "{name}: {value}")?;
        }
        writeln!(formatter, "HRESULT: 0x{:08X}", self.hresult())?;
        write!(formatter, "message: {}", self.message())
    }
}

impl std::error::Error for CommandFailure {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Undo {
    ComRegistration,
    Service,
    Profile(Profile),
    ProfileEnable(Profile),
    Category,
}

pub(crate) fn validation_failure(error: OperationError) -> CommandFailure {
    let stage = Stage::ValidateDllPath;
    CommandFailure::new(
        CommandKind::Register,
        stage,
        error.clone(),
        vec![Diagnostic::fail(stage, error)],
    )
}

pub(crate) fn run_register<B: RegistrationBackend>(
    backend: &mut B,
    dll_path: &str,
) -> Result<CommandReport, CommandFailure> {
    let mut diagnostics = Vec::new();
    let mut undo = Vec::new();

    run_registration_step(
        backend,
        Stage::CoInitializeEx,
        &mut diagnostics,
        &undo,
        RegistrationBackend::initialize_com,
    )?;

    let com_state = match backend.probe_com_registration(dll_path) {
        Ok(state) => {
            diagnostics.push(Diagnostic::ok(Stage::ComRegistryProbe));
            state
        }
        Err(error) => {
            return Err(fail_registration(
                backend,
                Stage::ComRegistryProbe,
                error,
                diagnostics,
                &undo,
            ));
        }
    };
    match com_state {
        ExistingComRegistration::Absent => {
            undo.push(Undo::ComRegistration);
            run_registration_step(
                backend,
                Stage::ComRegistryWrite,
                &mut diagnostics,
                &undo,
                |backend| backend.write_com_registration(dll_path),
            )?;
        }
        ExistingComRegistration::Exact => diagnostics.push(Diagnostic::skip(
            Stage::ComRegistryWrite,
            "matching registration already present; preserved",
        )),
        ExistingComRegistration::Conflicting => {
            let error = OperationError::new(
                E_FAIL,
                "existing prototype CLSID registration does not match the supplied DLL path and Apartment; no changes made",
            );
            return Err(fail_registration(
                backend,
                Stage::ComRegistryProbe,
                error,
                diagnostics,
                &undo,
            ));
        }
    }
    run_registration_step(
        backend,
        Stage::ComRegistryVerify,
        &mut diagnostics,
        &undo,
        |backend| backend.verify_com_registration(dll_path),
    )?;

    run_registration_step(
        backend,
        Stage::ProfilesCreate,
        &mut diagnostics,
        &undo,
        RegistrationBackend::create_profiles,
    )?;
    let service_exists = run_registration_probe(
        backend,
        Stage::ServiceProbe,
        &mut diagnostics,
        &undo,
        RegistrationBackend::service_registered,
    )?;
    if service_exists {
        diagnostics.push(Diagnostic::skip(
            Stage::ServiceRegister,
            "already present; preserved",
        ));
    } else {
        undo.push(Undo::Service);
        run_registration_step(
            backend,
            Stage::ServiceRegister,
            &mut diagnostics,
            &undo,
            RegistrationBackend::register_service,
        )?;
    }

    for profile in Profile::ALL {
        let exists = run_registration_probe(
            backend,
            Stage::ProfileProbe(profile),
            &mut diagnostics,
            &undo,
            |backend| backend.profile_registered(profile),
        )?;
        if exists {
            diagnostics.push(Diagnostic::skip(
                Stage::ProfileAdd(profile),
                "already present; preserved",
            ));
        } else {
            undo.push(Undo::Profile(profile));
            run_registration_step(
                backend,
                Stage::ProfileAdd(profile),
                &mut diagnostics,
                &undo,
                |backend| backend.add_profile(profile),
            )?;
        }

        let enabled = run_registration_probe(
            backend,
            Stage::ProfileEnabledProbe(profile),
            &mut diagnostics,
            &undo,
            |backend| backend.profile_enabled(profile),
        )?;
        if enabled {
            diagnostics.push(Diagnostic::skip(
                Stage::ProfileEnable(profile),
                "already enabled; preserved",
            ));
        } else {
            undo.push(Undo::ProfileEnable(profile));
            run_registration_step(
                backend,
                Stage::ProfileEnable(profile),
                &mut diagnostics,
                &undo,
                |backend| backend.set_profile_enabled(profile, true),
            )?;
        }
    }

    run_registration_step(
        backend,
        Stage::CategoryManagerCreate,
        &mut diagnostics,
        &undo,
        RegistrationBackend::create_category_manager,
    )?;
    let category_exists = run_registration_probe(
        backend,
        Stage::CategoryProbe,
        &mut diagnostics,
        &undo,
        RegistrationBackend::category_registered,
    )?;
    if category_exists {
        diagnostics.push(Diagnostic::skip(
            Stage::CategoryRegister,
            "already present; preserved",
        ));
    } else {
        undo.push(Undo::Category);
        run_registration_step(
            backend,
            Stage::CategoryRegister,
            &mut diagnostics,
            &undo,
            RegistrationBackend::register_category,
        )?;
    }

    Ok(CommandReport { diagnostics })
}

fn run_registration_step<B, F>(
    backend: &mut B,
    stage: Stage,
    diagnostics: &mut Vec<Diagnostic>,
    undo: &[Undo],
    operation: F,
) -> Result<(), CommandFailure>
where
    B: RegistrationBackend,
    F: FnOnce(&mut B) -> Result<(), OperationError>,
{
    match operation(backend) {
        Ok(()) => {
            diagnostics.push(Diagnostic::ok(stage));
            Ok(())
        }
        Err(error) => Err(fail_registration(
            backend,
            stage,
            error,
            std::mem::take(diagnostics),
            undo,
        )),
    }
}

fn run_registration_probe<B, F>(
    backend: &mut B,
    stage: Stage,
    diagnostics: &mut Vec<Diagnostic>,
    undo: &[Undo],
    operation: F,
) -> Result<bool, CommandFailure>
where
    B: RegistrationBackend,
    F: FnOnce(&mut B) -> Result<bool, OperationError>,
{
    match operation(backend) {
        Ok(value) => {
            diagnostics.push(Diagnostic::ok(stage));
            Ok(value)
        }
        Err(error) => Err(fail_registration(
            backend,
            stage,
            error,
            std::mem::take(diagnostics),
            undo,
        )),
    }
}

fn fail_registration<B: RegistrationBackend>(
    backend: &mut B,
    stage: Stage,
    error: OperationError,
    mut diagnostics: Vec<Diagnostic>,
    undo: &[Undo],
) -> CommandFailure {
    diagnostics.push(Diagnostic::fail(stage, error.clone()));
    for action in undo.iter().rev().copied() {
        let (rollback_stage, result) = match action {
            Undo::Category => (Stage::CategoryUnregister, backend.unregister_category()),
            Undo::ProfileEnable(profile) => (
                Stage::ProfileDisable(profile),
                backend.set_profile_enabled(profile, false),
            ),
            Undo::Profile(profile) => (
                Stage::ProfileRemove(profile),
                backend.remove_profile(profile),
            ),
            Undo::Service => (Stage::ServiceUnregister, backend.unregister_service()),
            Undo::ComRegistration => (Stage::ComRegistryRemove, backend.remove_com_registration()),
        };
        diagnostics.push(Diagnostic::rollback(rollback_stage, &result));
    }
    CommandFailure::new(CommandKind::Register, stage, error, diagnostics)
}

pub(crate) fn run_unregister<B: RegistrationBackend>(
    backend: &mut B,
) -> Result<CommandReport, CommandFailure> {
    let mut diagnostics = Vec::new();
    if let Err(error) = backend.initialize_com() {
        diagnostics.push(Diagnostic::fail(Stage::CoInitializeEx, error.clone()));
        return Err(CommandFailure::new(
            CommandKind::Unregister,
            Stage::CoInitializeEx,
            error,
            diagnostics,
        ));
    }
    diagnostics.push(Diagnostic::ok(Stage::CoInitializeEx));

    let mut first_failure: Option<(Stage, OperationError)> = None;

    match backend.create_category_manager() {
        Ok(()) => {
            diagnostics.push(Diagnostic::ok(Stage::CategoryManagerCreate));
            match backend.category_registered() {
                Ok(true) => {
                    diagnostics.push(Diagnostic::ok(Stage::CategoryProbe));
                    record_cleanup(
                        Stage::CategoryUnregister,
                        backend.unregister_category(),
                        &mut diagnostics,
                        &mut first_failure,
                    );
                }
                Ok(false) => {
                    diagnostics.push(Diagnostic::ok(Stage::CategoryProbe));
                    diagnostics.push(Diagnostic::skip(
                        Stage::CategoryUnregister,
                        "already absent",
                    ));
                }
                Err(error) => record_cleanup(
                    Stage::CategoryProbe,
                    Err(error),
                    &mut diagnostics,
                    &mut first_failure,
                ),
            }
        }
        Err(error) => record_cleanup(
            Stage::CategoryManagerCreate,
            Err(error),
            &mut diagnostics,
            &mut first_failure,
        ),
    }

    match backend.create_profiles() {
        Ok(()) => {
            diagnostics.push(Diagnostic::ok(Stage::ProfilesCreate));
            for profile in Profile::ALL {
                cleanup_profile(backend, profile, &mut diagnostics, &mut first_failure);
            }
            match backend.service_registered() {
                Ok(true) => {
                    diagnostics.push(Diagnostic::ok(Stage::ServiceProbe));
                    record_cleanup(
                        Stage::ServiceUnregister,
                        backend.unregister_service(),
                        &mut diagnostics,
                        &mut first_failure,
                    );
                }
                Ok(false) => {
                    diagnostics.push(Diagnostic::ok(Stage::ServiceProbe));
                    diagnostics.push(Diagnostic::skip(Stage::ServiceUnregister, "already absent"));
                }
                Err(error) => record_cleanup(
                    Stage::ServiceProbe,
                    Err(error),
                    &mut diagnostics,
                    &mut first_failure,
                ),
            }
        }
        Err(error) => record_cleanup(
            Stage::ProfilesCreate,
            Err(error),
            &mut diagnostics,
            &mut first_failure,
        ),
    }

    match backend.com_registration_exists() {
        Ok(true) => {
            diagnostics.push(Diagnostic::ok(Stage::ComRegistryProbe));
            record_cleanup(
                Stage::ComRegistryRemove,
                backend.remove_com_registration(),
                &mut diagnostics,
                &mut first_failure,
            );
        }
        Ok(false) => {
            diagnostics.push(Diagnostic::ok(Stage::ComRegistryProbe));
            diagnostics.push(Diagnostic::skip(Stage::ComRegistryRemove, "already absent"));
        }
        Err(error) => record_cleanup(
            Stage::ComRegistryProbe,
            Err(error),
            &mut diagnostics,
            &mut first_failure,
        ),
    }

    if let Some((stage, error)) = first_failure {
        Err(CommandFailure::new(
            CommandKind::Unregister,
            stage,
            error,
            diagnostics,
        ))
    } else {
        Ok(CommandReport { diagnostics })
    }
}

fn cleanup_profile<B: RegistrationBackend>(
    backend: &mut B,
    profile: Profile,
    diagnostics: &mut Vec<Diagnostic>,
    first_failure: &mut Option<(Stage, OperationError)>,
) {
    match backend.profile_registered(profile) {
        Ok(true) => {
            diagnostics.push(Diagnostic::ok(Stage::ProfileProbe(profile)));
            match backend.profile_enabled(profile) {
                Ok(true) => {
                    diagnostics.push(Diagnostic::ok(Stage::ProfileEnabledProbe(profile)));
                    record_cleanup(
                        Stage::ProfileDisable(profile),
                        backend.set_profile_enabled(profile, false),
                        diagnostics,
                        first_failure,
                    );
                }
                Ok(false) => {
                    diagnostics.push(Diagnostic::ok(Stage::ProfileEnabledProbe(profile)));
                    diagnostics.push(Diagnostic::skip(
                        Stage::ProfileDisable(profile),
                        "already disabled",
                    ));
                }
                Err(error) => record_cleanup(
                    Stage::ProfileEnabledProbe(profile),
                    Err(error),
                    diagnostics,
                    first_failure,
                ),
            }
            record_cleanup(
                Stage::ProfileRemove(profile),
                backend.remove_profile(profile),
                diagnostics,
                first_failure,
            );
        }
        Ok(false) => {
            diagnostics.push(Diagnostic::ok(Stage::ProfileProbe(profile)));
            diagnostics.push(Diagnostic::skip(
                Stage::ProfileRemove(profile),
                "already absent",
            ));
        }
        Err(error) => record_cleanup(
            Stage::ProfileProbe(profile),
            Err(error),
            diagnostics,
            first_failure,
        ),
    }
}

fn record_cleanup(
    stage: Stage,
    result: Result<(), OperationError>,
    diagnostics: &mut Vec<Diagnostic>,
    first_failure: &mut Option<(Stage, OperationError)>,
) {
    match result {
        Ok(()) => diagnostics.push(Diagnostic::ok(stage)),
        Err(error) => {
            diagnostics.push(Diagnostic::fail(stage, error.clone()));
            if first_failure.is_none() {
                *first_failure = Some((stage, error));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    const TEST_PATH: &str = r"C:\dev\prototype.dll";
    const TEST_FAILURE: HRESULT = HRESULT(0x80004005_u32 as i32);
    const ROLLBACK_FAILURE: HRESULT = HRESULT(0x80070005_u32 as i32);

    #[derive(Default)]
    struct FakeBackend {
        failures: HashMap<Stage, OperationError>,
        calls: Vec<Stage>,
        com_initialized: bool,
        com_registration: bool,
        service: bool,
        profiles: HashSet<Profile>,
        enabled: HashSet<Profile>,
        category: bool,
    }

    impl FakeBackend {
        fn fail_at(&mut self, stage: Stage, hresult: HRESULT) {
            self.failures
                .insert(stage, OperationError::new(hresult, "fake failure"));
        }

        fn call(&mut self, stage: Stage) -> Result<(), OperationError> {
            self.calls.push(stage);
            self.failures.get(&stage).cloned().map_or(Ok(()), Err)
        }

        fn call_value<T>(&mut self, stage: Stage, value: T) -> Result<T, OperationError> {
            self.call(stage).map(|()| value)
        }
    }

    impl RegistrationBackend for FakeBackend {
        fn initialize_com(&mut self) -> Result<(), OperationError> {
            self.call(Stage::CoInitializeEx)?;
            self.com_initialized = true;
            Ok(())
        }

        fn probe_com_registration(
            &mut self,
            _expected_dll_path: &str,
        ) -> Result<ExistingComRegistration, OperationError> {
            let state = if self.com_registration {
                ExistingComRegistration::Exact
            } else {
                ExistingComRegistration::Absent
            };
            self.call_value(Stage::ComRegistryProbe, state)
        }

        fn write_com_registration(&mut self, _dll_path: &str) -> Result<(), OperationError> {
            self.call(Stage::ComRegistryWrite)?;
            self.com_registration = true;
            Ok(())
        }

        fn verify_com_registration(&mut self, _dll_path: &str) -> Result<(), OperationError> {
            self.call(Stage::ComRegistryVerify)
        }

        fn com_registration_exists(&mut self) -> Result<bool, OperationError> {
            self.call_value(Stage::ComRegistryProbe, self.com_registration)
        }

        fn remove_com_registration(&mut self) -> Result<(), OperationError> {
            self.call(Stage::ComRegistryRemove)?;
            self.com_registration = false;
            Ok(())
        }

        fn create_profiles(&mut self) -> Result<(), OperationError> {
            self.call(Stage::ProfilesCreate)
        }

        fn service_registered(&mut self) -> Result<bool, OperationError> {
            self.call_value(Stage::ServiceProbe, self.service)
        }

        fn register_service(&mut self) -> Result<(), OperationError> {
            self.call(Stage::ServiceRegister)?;
            self.service = true;
            Ok(())
        }

        fn unregister_service(&mut self) -> Result<(), OperationError> {
            self.call(Stage::ServiceUnregister)?;
            self.service = false;
            Ok(())
        }

        fn profile_registered(&mut self, profile: Profile) -> Result<bool, OperationError> {
            self.call_value(
                Stage::ProfileProbe(profile),
                self.profiles.contains(&profile),
            )
        }

        fn add_profile(&mut self, profile: Profile) -> Result<(), OperationError> {
            self.call(Stage::ProfileAdd(profile))?;
            self.profiles.insert(profile);
            Ok(())
        }

        fn profile_enabled(&mut self, profile: Profile) -> Result<bool, OperationError> {
            self.call_value(
                Stage::ProfileEnabledProbe(profile),
                self.enabled.contains(&profile),
            )
        }

        fn set_profile_enabled(
            &mut self,
            profile: Profile,
            enabled: bool,
        ) -> Result<(), OperationError> {
            let stage = if enabled {
                Stage::ProfileEnable(profile)
            } else {
                Stage::ProfileDisable(profile)
            };
            self.call(stage)?;
            if enabled {
                self.enabled.insert(profile);
            } else {
                self.enabled.remove(&profile);
            }
            Ok(())
        }

        fn remove_profile(&mut self, profile: Profile) -> Result<(), OperationError> {
            self.call(Stage::ProfileRemove(profile))?;
            self.enabled.remove(&profile);
            self.profiles.remove(&profile);
            Ok(())
        }

        fn create_category_manager(&mut self) -> Result<(), OperationError> {
            self.call(Stage::CategoryManagerCreate)
        }

        fn category_registered(&mut self) -> Result<bool, OperationError> {
            self.call_value(Stage::CategoryProbe, self.category)
        }

        fn register_category(&mut self) -> Result<(), OperationError> {
            self.call(Stage::CategoryRegister)?;
            self.category = true;
            Ok(())
        }

        fn unregister_category(&mut self) -> Result<(), OperationError> {
            self.call(Stage::CategoryUnregister)?;
            self.category = false;
            Ok(())
        }
    }

    fn assert_failed_at(stage: Stage) -> (FakeBackend, CommandFailure) {
        let mut backend = FakeBackend::default();
        backend.fail_at(stage, TEST_FAILURE);
        let failure = run_register(&mut backend, TEST_PATH).unwrap_err();
        assert_eq!(failure.stage, stage);
        assert_eq!(failure.error.hresult, TEST_FAILURE);
        (backend, failure)
    }

    #[test]
    fn reports_com_registration_failure_and_leaves_no_state() {
        let (backend, _) = assert_failed_at(Stage::ComRegistryWrite);
        assert!(!backend.com_registration);
        assert!(!backend.service);
    }

    #[test]
    fn reports_tsf_register_failure_and_rolls_back_com() {
        let (backend, _) = assert_failed_at(Stage::ServiceRegister);
        assert!(!backend.com_registration);
        assert!(!backend.service);
    }

    #[test]
    fn reports_first_language_profile_failure() {
        let (backend, _) = assert_failed_at(Stage::ProfileAdd(Profile::English));
        assert!(backend.profiles.is_empty());
        assert!(!backend.service);
        assert!(!backend.com_registration);
    }

    #[test]
    fn reports_second_language_profile_failure() {
        let (backend, _) = assert_failed_at(Stage::ProfileAdd(Profile::SimplifiedChinese));
        assert!(backend.profiles.is_empty());
        assert!(backend.enabled.is_empty());
        assert!(!backend.service);
        assert!(!backend.com_registration);
    }

    #[test]
    fn reports_category_registration_failure() {
        let (backend, _) = assert_failed_at(Stage::CategoryRegister);
        assert!(!backend.category);
        assert!(backend.profiles.is_empty());
        assert!(backend.enabled.is_empty());
        assert!(!backend.service);
        assert!(!backend.com_registration);
    }

    #[test]
    fn rollback_runs_in_reverse_creation_order() {
        let (backend, _) = assert_failed_at(Stage::CategoryRegister);
        let rollback = backend
            .calls
            .iter()
            .copied()
            .filter(|stage| {
                matches!(
                    stage,
                    Stage::CategoryUnregister
                        | Stage::ProfileDisable(_)
                        | Stage::ProfileRemove(_)
                        | Stage::ServiceUnregister
                        | Stage::ComRegistryRemove
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            rollback,
            vec![
                Stage::CategoryUnregister,
                Stage::ProfileDisable(Profile::SimplifiedChinese),
                Stage::ProfileRemove(Profile::SimplifiedChinese),
                Stage::ProfileDisable(Profile::English),
                Stage::ProfileRemove(Profile::English),
                Stage::ServiceUnregister,
                Stage::ComRegistryRemove,
            ]
        );
    }

    #[test]
    fn original_failure_is_preserved_when_rollback_fails() {
        let mut backend = FakeBackend::default();
        backend.fail_at(Stage::ProfileAdd(Profile::SimplifiedChinese), TEST_FAILURE);
        backend.fail_at(Stage::ServiceUnregister, ROLLBACK_FAILURE);

        let failure = run_register(&mut backend, TEST_PATH).unwrap_err();

        assert_eq!(failure.stage, Stage::ProfileAdd(Profile::SimplifiedChinese));
        assert_eq!(failure.error.hresult, TEST_FAILURE);
        assert!(failure.diagnostics.iter().any(|diagnostic| {
            diagnostic.status == DiagnosticStatus::RollbackFail
                && diagnostic.stage == Stage::ServiceUnregister
                && diagnostic.error.as_ref().map(|error| error.hresult) == Some(ROLLBACK_FAILURE)
        }));
    }

    #[test]
    fn successful_registration_creates_full_expected_state() {
        let mut backend = FakeBackend::default();
        let report = run_register(&mut backend, TEST_PATH).unwrap();
        assert!(!report.diagnostics.is_empty());
        assert!(backend.com_registration);
        assert!(backend.service);
        assert_eq!(backend.profiles.len(), 2);
        assert_eq!(backend.enabled.len(), 2);
        assert!(backend.category);
    }

    #[test]
    fn repeated_cleanup_is_safe() {
        let mut backend = FakeBackend::default();
        run_register(&mut backend, TEST_PATH).unwrap();
        run_unregister(&mut backend).unwrap();
        let second = run_unregister(&mut backend).unwrap();

        assert!(!backend.com_registration);
        assert!(!backend.service);
        assert!(backend.profiles.is_empty());
        assert!(!backend.category);
        assert!(second
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.status == DiagnosticStatus::Skip));
    }

    #[test]
    fn diagnostics_include_stage_name_and_hresult() {
        let (_, failure) = assert_failed_at(Stage::ProfileAdd(Profile::SimplifiedChinese));
        let line = failure
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.status == DiagnosticStatus::Fail)
            .unwrap()
            .to_string();
        assert!(line.contains("[fail] AddLanguageProfile"));
        assert!(line.contains("language=0x0804"));
        assert!(line.contains("HRESULT=0x80004005"));
        assert!(failure.to_string().contains("stage: AddLanguageProfile"));
    }

    #[test]
    fn preexisting_matching_state_is_not_removed_after_later_failure() {
        let mut backend = FakeBackend {
            com_registration: true,
            service: true,
            profiles: HashSet::from([Profile::English]),
            enabled: HashSet::from([Profile::English]),
            ..FakeBackend::default()
        };
        backend.fail_at(Stage::ProfileAdd(Profile::SimplifiedChinese), TEST_FAILURE);

        run_register(&mut backend, TEST_PATH).unwrap_err();

        assert!(backend.com_registration);
        assert!(backend.service);
        assert!(backend.profiles.contains(&Profile::English));
        assert!(backend.enabled.contains(&Profile::English));
    }
}
