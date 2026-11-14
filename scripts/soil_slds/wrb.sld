<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ogc="http://www.opengis.net/ogc" xmlns:gml="http://www.opengis.net/gml" xsi:schemaLocation="http://www.opengis.net/sld StyledLayerDescriptor.xsd" version="1.0.0">
  <NamedLayer>
    <Name>MostProbable</Name>
    <UserStyle>
      <Title>MostProbable</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
           <Geometry>
              <PropertyName>Most probable WRB class</PropertyName>
              <Opacity>1</Opacity>
            </Geometry>
            <ColorMap type="values">
              <ColorMapEntry color="#FFFFFF" quantity="255" label="NODATA" opacity="0.7"/>
              <ColorMapEntry color="#f7991d" label="Acrisols" quantity="0"/>
              <ColorMapEntry color="#9b9d57" label="Albeluvisols" quantity="1"/>
              <ColorMapEntry color="#faf7c0" label="Alisols" quantity="2"/>
              <ColorMapEntry color="#ed3a33" label="Andosols" quantity="3"/>
              <ColorMapEntry color="#f7d8ac" label="Arenosols" quantity="4"/>
              <ColorMapEntry color="#ffee00" label="Calcisols" quantity="5"/>
              <ColorMapEntry color="#fecd67" label="Cambisols" quantity="6"/>
              <ColorMapEntry color="#e2c837" label="Chernozems" quantity="7"/>
              <ColorMapEntry color="#756a92" label="Cryosols" quantity="8"/>
              <ColorMapEntry color="#efe6bf" label="Durisols" quantity="9"/>
              <ColorMapEntry color="#f6872d" label="Ferralsols" quantity="10"/>
              <ColorMapEntry color="#01b0ef" label="Fluvisols" quantity="11"/>
              <ColorMapEntry color="#9291b9" label="Gleysols" quantity="12"/>
              <ColorMapEntry color="#fbf6a5" label="Gypsisols" quantity="13"/>
              <ColorMapEntry color="#8b898a" label="Histosols" quantity="14"/>
              <ColorMapEntry color="#c99580" label="Kastanozems" quantity="15"/>
              <ColorMapEntry color="#d5d6d8" label="Leptosols" quantity="16"/>
              <ColorMapEntry color="#f9bdbf" label="Lixisols" quantity="17"/>
              <ColorMapEntry color="#f48385" label="Luvisols" quantity="18"/>
              <ColorMapEntry color="#f7a082" label="Nitisols" quantity="19"/>
              <ColorMapEntry color="#ba6850" label="Phaeozems" quantity="20"/>
              <ColorMapEntry color="#f59354" label="Planosols" quantity="21"/>
              <ColorMapEntry color="#6f0e41" label="Plinthosols" quantity="22"/>
              <ColorMapEntry color="#0daf63" label="Podzols" quantity="23"/>
              <ColorMapEntry color="#ffe2ae" label="Regosols" quantity="24"/>
              <ColorMapEntry color="#ed3994" label="Solonchaks" quantity="25"/>
              <ColorMapEntry color="#f4cde2" label="Solonetz" quantity="26"/>
              <ColorMapEntry color="#40c1eb" label="Stagnosols" quantity="27"/>
              <ColorMapEntry color="#618f82" label="Umbrisols" quantity="28"/>
              <ColorMapEntry color="#9e567c" label="Vertisols" quantity="29"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>