// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity 0.8.26;

contract JoinSplit2x2Groth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20795459224953934783102106448420082608387164135129622007722732251725760683579;
    uint256 constant alphay  = 7858142057181239145590182775411756382129286418781276092603913632768968071483;
    uint256 constant betax1  = 100661932550428604442085675774287542675969638500510427824597785153534208542;
    uint256 constant betax2  = 21254854275528387360942998913594953300314036800177471800242605472386845837230;
    uint256 constant betay1  = 5087321408538359800246974194573793604891364142828477529783293233183020786275;
    uint256 constant betay2  = 20228133443620650965642919875720595454510237513715795510137155996338469708340;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 10173445174987751302082412616969562007825389919329276646516959782309264803178;
    uint256 constant deltax2 = 7040592227046292870716311256550424701383387426705350952175067611900179027934;
    uint256 constant deltay1 = 15901403964538546712042444716477481329527824047127921661276620658913577200817;
    uint256 constant deltay2 = 12688206971603849416149778081346570494686934070819653707793373135618168144892;

    
    uint256 constant IC0x = 401623951299635277461623335629170476478857235871049973446051048135248615836;
    uint256 constant IC0y = 6487294937144139863390683192650946674465034960159535656992504140864025448273;
    
    uint256 constant IC1x = 19393161205467106211546282817097441918909072339744937757271783354472062035740;
    uint256 constant IC1y = 5471819113981136542920707171282138259452667675472522222351055185770835289304;
    
    uint256 constant IC2x = 21805779694717866269145480014917144268738983416252163109227926633112557445866;
    uint256 constant IC2y = 18136603631820486172988370197454744132931030149556304572508523904266586697614;
    
    uint256 constant IC3x = 4871114629578039320488751983131218715702576321393561065047668163327332266685;
    uint256 constant IC3y = 20638031486523698003564048691826053437959765276327765610862749149679426016361;
    
    uint256 constant IC4x = 21468308992251810862096944079546698518798900642466234473698163698330682260119;
    uint256 constant IC4y = 15046725289443597837708421749360827701211552321193761076118897259569629091443;
    
    uint256 constant IC5x = 13288695109255637267466668476248965071242967196486684020676921365621583979116;
    uint256 constant IC5y = 13106790871786640039188377230530810418046472088698615002567479838261993713709;
    
    uint256 constant IC6x = 724039194009905888973884461457681696968742908380840570305464517303480693051;
    uint256 constant IC6y = 11738474955357724462479073806076021103506046406638314912734132010540445087755;
    
    uint256 constant IC7x = 665802710334348090785590111059533004731776104304490715728389134469033841427;
    uint256 constant IC7y = 10078504436279881506480404658577297212462959336698737409368266906252400456782;
    
    uint256 constant IC8x = 14583038640979497877257596632149837847055719874039783528364624523601657527829;
    uint256 constant IC8y = 2610950055890501876273773424492975535746994135958065877761507031718435963956;
    
    uint256 constant IC9x = 1935709379085900109698975532635640472105530189042968120104130540608659154991;
    uint256 constant IC9y = 21118350617268853292487666255033408307156919955309240675921444104207431350834;
    
    uint256 constant IC10x = 5918754622152822195360727385895414675973245796279020079707027969181157673473;
    uint256 constant IC10y = 5545002247251571764807501273109530044869213125009822332448847768281897521752;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[10] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
